import nacl from 'tweetnacl'
import { describe, expect, it } from 'vitest'
import {
  HOST_MESH_OFFER_DOMAIN,
  HOST_MESH_PAYLOAD_VERSION,
  type HostMeshOfferPayload,
  type HostMeshSealedOffer
} from '../../shared/host-mesh/host-mesh-contract'
import { orcaHostKeyOf } from '../host-graph/host-graph-self-identity'
import { openHostMeshSealedOffer, sealHostMeshOffer } from './host-mesh-sealed-offer'

const NOW = 1_700_000_000_000

type Machine = { keyPair: nacl.BoxKeyPair; hostKey: string }

function machine(): Machine {
  const keyPair = nacl.box.keyPair()
  return { keyPair, hostKey: orcaHostKeyOf(Buffer.from(keyPair.publicKey).toString('base64')) }
}

function offerFor(args: {
  minter: Machine
  recipient: Machine
  expiresAt: number
}): HostMeshOfferPayload {
  return {
    version: HOST_MESH_PAYLOAD_VERSION,
    groupId: 'group-studio',
    epoch: 7,
    minterHostKey: args.minter.hostKey,
    recipientHostKey: args.recipient.hostKey,
    introducedBy: 'introducer-host-key',
    offerUrl: 'orca://pair?offer=abc123',
    endpointCandidates: ['ws://10.0.0.4:4477', 'wss://studio.example:4477'],
    expiresAt: args.expiresAt,
    nonce: 'offer-nonce-1'
  }
}

function sealedFor(args: {
  minter: Machine
  recipient: Machine
  expiresAt?: number
  payload?: HostMeshOfferPayload
}): { sealed: HostMeshSealedOffer; payload: HostMeshOfferPayload } {
  const payload =
    args.payload ??
    offerFor({
      minter: args.minter,
      recipient: args.recipient,
      expiresAt: args.expiresAt ?? NOW + 600_000
    })
  return {
    sealed: sealHostMeshOffer({
      payload,
      senderSecretKey: args.minter.keyPair.secretKey,
      recipientPublicKey: args.recipient.keyPair.publicKey
    }),
    payload
  }
}

function open(
  sealed: HostMeshSealedOffer,
  args: { recipient: Machine; sender: Machine; now?: number }
): { payload: HostMeshOfferPayload | null; reasons: string[] } {
  const reasons: string[] = []
  const payload = openHostMeshSealedOffer({
    sealed,
    recipientHostKey: args.recipient.hostKey,
    recipientSecretKey: args.recipient.keyPair.secretKey,
    senderPublicKey: args.sender.keyPair.publicKey,
    now: args.now ?? NOW,
    onInvalid: (reason) => reasons.push(reason)
  })
  return { payload, reasons }
}

/** The same box a minter would produce, but framed with another domain, as an attacker's replay would be. */
function sealWithDomain(args: {
  domain: string
  payload: HostMeshOfferPayload
  sender: Machine
  recipient: Machine
}): HostMeshSealedOffer {
  const nonce = nacl.randomBytes(nacl.box.nonceLength)
  const plaintext = new TextEncoder().encode(`${args.domain}\0${JSON.stringify(args.payload)}`)
  return {
    version: HOST_MESH_PAYLOAD_VERSION,
    recipientHostKey: args.recipient.hostKey,
    senderHostKey: args.sender.hostKey,
    nonceB64: Buffer.from(nonce).toString('base64'),
    ciphertextB64: Buffer.from(
      nacl.box(plaintext, nonce, args.recipient.keyPair.publicKey, args.sender.keyPair.secretKey)
    ).toString('base64')
  }
}

describe('a sealed offer', () => {
  it('opens for its recipient and round-trips every field', () => {
    const minter = machine()
    const recipient = machine()
    const { sealed, payload } = sealedFor({ minter, recipient })
    const reasons: string[] = []

    const opened = openHostMeshSealedOffer({
      sealed,
      recipientHostKey: recipient.hostKey,
      recipientSecretKey: recipient.keyPair.secretKey,
      senderPublicKey: minter.keyPair.publicKey,
      now: NOW,
      onInvalid: (reason) => reasons.push(reason)
    })

    expect(opened).toEqual(payload)
    expect(opened?.offerUrl).toBe('orca://pair?offer=abc123')
    expect(opened?.endpointCandidates).toEqual(['ws://10.0.0.4:4477', 'wss://studio.example:4477'])
    expect(reasons).toEqual([])
    expect(sealed.recipientHostKey).toBe(recipient.hostKey)
    expect(sealed.senderHostKey).toBe(minter.hostKey)
  })

  it('is refused by a machine it is not addressed to, even though that machine holds a valid key', () => {
    const minter = machine()
    const recipient = machine()
    const stranger = machine()
    const { sealed } = sealedFor({ minter, recipient })

    const wrongMachine = open(sealed, { recipient: stranger, sender: minter })
    expect(wrongMachine.payload).toBeNull()
    expect(wrongMachine.reasons).toEqual(['offer-recipient'])
    expect(sealed.recipientHostKey).not.toBe(stranger.hostKey)

    const rightMachine = open(sealed, { recipient, sender: minter })
    expect(rightMachine.payload?.nonce).toBe('offer-nonce-1')
  })

  it('is refused when one byte of the ciphertext is changed', () => {
    const minter = machine()
    const recipient = machine()
    const { sealed } = sealedFor({ minter, recipient })
    const ciphertext = Buffer.from(sealed.ciphertextB64, 'base64')
    ciphertext[12] ^= 0x01

    const tampered = open(
      { ...sealed, ciphertextB64: ciphertext.toString('base64') },
      { recipient, sender: minter }
    )

    expect(tampered.payload).toBeNull()
    expect(tampered.reasons).toEqual(['offer-box-open'])
  })

  it('is refused when the courier splices a different sender onto the box', () => {
    const minter = machine()
    const recipient = machine()
    const other = machine()
    const { sealed } = sealedFor({ minter, recipient })

    const claimedOther = open(sealed, { recipient, sender: other })
    expect(claimedOther.payload).toBeNull()
    expect(claimedOther.reasons).toEqual(['offer-sender'])

    const forgedSender = open(
      { ...sealed, senderHostKey: other.hostKey },
      { recipient, sender: other }
    )
    expect(forgedSender.payload).toBeNull()
    expect(forgedSender.reasons).toEqual(['offer-box-open'])
  })

  it('is refused once it has expired', () => {
    const minter = machine()
    const recipient = machine()
    const { sealed } = sealedFor({ minter, recipient, expiresAt: NOW - 1 })

    const expired = open(sealed, { recipient, sender: minter })
    expect(expired.payload).toBeNull()
    expect(expired.reasons).toEqual(['offer-expired'])

    const stillValid = open(sealed, { recipient, sender: minter, now: NOW - 2 })
    expect(stillValid.payload?.expiresAt).toBe(NOW - 1)
  })

  it('is refused when it was framed with another domain', () => {
    const minter = machine()
    const recipient = machine()
    const payload = offerFor({ minter, recipient, expiresAt: NOW + 600_000 })
    const wrongDomain = sealWithDomain({
      domain: 'orca-mesh-offer/v2',
      payload,
      sender: minter,
      recipient
    })

    const replayed = open(wrongDomain, { recipient, sender: minter })
    expect(replayed.payload).toBeNull()
    expect(replayed.reasons).toEqual(['offer-domain'])

    const rightDomain = sealWithDomain({
      domain: HOST_MESH_OFFER_DOMAIN,
      payload,
      sender: minter,
      recipient
    })
    expect(open(rightDomain, { recipient, sender: minter }).payload).toEqual(payload)
  })

  it('is refused when a base64 field is not canonical', () => {
    const minter = machine()
    const recipient = machine()
    const { sealed } = sealedFor({ minter, recipient })

    const spacedNonce = open(
      { ...sealed, nonceB64: ` ${sealed.nonceB64}` },
      { recipient, sender: minter }
    )
    expect(spacedNonce.payload).toBeNull()
    expect(spacedNonce.reasons).toEqual(['offer-nonce'])

    const wrappedCiphertext = open(
      {
        ...sealed,
        ciphertextB64: `${sealed.ciphertextB64.slice(0, 8)}\n${sealed.ciphertextB64.slice(8)}`
      },
      { recipient, sender: minter }
    )
    expect(wrappedCiphertext.payload).toBeNull()
    expect(wrappedCiphertext.reasons).toEqual(['offer-ciphertext'])
  })

  it('reports a short reason and never a key, a nonce or the plaintext', () => {
    const minter = machine()
    const recipient = machine()
    const other = machine()
    const { sealed, payload } = sealedFor({ minter, recipient })
    const tampered = Buffer.from(sealed.ciphertextB64, 'base64')
    tampered[0] ^= 0xff
    const expired = sealedFor({ minter, recipient, expiresAt: NOW - 1 }).sealed

    const reasons = [
      ...open(sealed, { recipient: other, sender: minter }).reasons,
      ...open({ ...sealed, nonceB64: 'not-a-nonce' }, { recipient, sender: minter }).reasons,
      ...open(
        { ...sealed, ciphertextB64: tampered.toString('base64') },
        { recipient, sender: minter }
      ).reasons,
      ...open(sealed, { recipient, sender: other }).reasons,
      ...open(expired, { recipient, sender: minter }).reasons
    ]

    expect(reasons).toEqual([
      'offer-recipient',
      'offer-nonce',
      'offer-box-open',
      'offer-sender',
      'offer-expired'
    ])
    const secrets = [
      sealed.nonceB64,
      sealed.ciphertextB64,
      sealed.senderHostKey,
      sealed.recipientHostKey,
      minter.hostKey,
      recipient.hostKey,
      payload.offerUrl,
      payload.groupId,
      payload.nonce,
      JSON.stringify(payload)
    ]
    for (const reason of reasons) {
      expect(reason).toMatch(/^offer-[a-z-]{1,20}$/)
      for (const secret of secrets) {
        expect(reason).not.toContain(secret)
      }
    }
  })
})
