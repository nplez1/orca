// X25519 host keys cannot sign, so a static-static box is the closest thing a host has to a signature.
import nacl from 'tweetnacl'
import {
  HOST_MESH_MAX_ENDPOINT_CANDIDATES,
  HOST_MESH_OFFER_DOMAIN,
  HOST_MESH_PAYLOAD_VERSION,
  type HostMeshOfferPayload,
  type HostMeshSealedOffer
} from '../../shared/host-mesh/host-mesh-contract'
import { orcaHostKeyOf } from '../host-graph/host-graph-self-identity'
import {
  decodeCanonicalBase64,
  encodeText,
  equalBytes
} from '../runtime/hosts/identity/host-challenge-envelope'

/**
 * An offer sealed to exactly one machine, carried by an introducer that cannot open it.
 *
 * Why static-static and not an ephemeral handshake: the introducer relays a box it must not read, so the
 * only two parties that may hold the plaintext are the minter and the recipient — and both already hold
 * static host keys, so a sender-static/recipient-static box gives confidentiality to the recipient and
 * authenticity from the sender in one primitive.
 *
 * Why the domain prefix: a box that opens here must not be openable as a challenge, a proof, or any other
 * box on the same key pair, so the first bytes say what the plaintext is before anything is parsed.
 */

const strictUtf8 = new TextDecoder('utf-8', { fatal: true })

const PAYLOAD_FIELDS = [
  'version',
  'groupId',
  'epoch',
  'minterHostKey',
  'recipientHostKey',
  'introducedBy',
  'offerUrl',
  'endpointCandidates',
  'expiresAt',
  'nonce'
] as const

export function sealHostMeshOffer(args: {
  payload: HostMeshOfferPayload
  senderSecretKey: Uint8Array
  recipientPublicKey: Uint8Array
}): HostMeshSealedOffer {
  const nonce = nacl.randomBytes(nacl.box.nonceLength)
  const plaintext = encodeText(`${HOST_MESH_OFFER_DOMAIN}\0${JSON.stringify(args.payload)}`)
  const ciphertext = nacl.box(plaintext, nonce, args.recipientPublicKey, args.senderSecretKey)
  return {
    version: HOST_MESH_PAYLOAD_VERSION,
    // Derived from the keys the box was actually sealed to and with, never copied from the payload: a
    // payload that names a different pair then fails to open instead of minting an unopenable box.
    recipientHostKey: hostKeyOf(args.recipientPublicKey),
    senderHostKey: hostKeyOf(nacl.box.keyPair.fromSecretKey(args.senderSecretKey).publicKey),
    nonceB64: Buffer.from(nonce).toString('base64'),
    ciphertextB64: Buffer.from(ciphertext).toString('base64')
  }
}

/** Reject a box this machine cannot be the recipient of; `onInvalid` gets a reason, never a field value. */
export function openHostMeshSealedOffer(args: {
  sealed: HostMeshSealedOffer
  recipientHostKey: string
  recipientSecretKey: Uint8Array
  /** The minter, as the courier names it; the box must agree with that claim. */
  senderPublicKey: Uint8Array
  now: number
  onInvalid?: (reason: string) => void
}): HostMeshOfferPayload | null {
  const { sealed, onInvalid } = args
  const refuse = (reason: string): null => {
    onInvalid?.(reason)
    return null
  }

  if (sealed.version !== HOST_MESH_PAYLOAD_VERSION) {
    return refuse('offer-envelope-version')
  }
  if (sealed.recipientHostKey !== args.recipientHostKey) {
    return refuse('offer-recipient')
  }
  if (sealed.senderHostKey !== hostKeyOf(args.senderPublicKey)) {
    return refuse('offer-sender')
  }
  if (
    args.senderPublicKey.byteLength !== nacl.box.publicKeyLength ||
    args.recipientSecretKey.byteLength !== nacl.box.secretKeyLength
  ) {
    return refuse('offer-key-size')
  }
  const nonce = decodeCanonicalBase64(sealed.nonceB64, nacl.box.nonceLength)
  if (!nonce) {
    return refuse('offer-nonce')
  }
  // Why not `decodeCanonicalBase64`: a box's length is only known once its plaintext is, so canonical
  // form is the round-trip and nothing else.
  const ciphertext = Buffer.from(sealed.ciphertextB64, 'base64')
  if (ciphertext.toString('base64') !== sealed.ciphertextB64) {
    return refuse('offer-ciphertext')
  }
  const plaintext = nacl.box.open(ciphertext, nonce, args.senderPublicKey, args.recipientSecretKey)
  if (!plaintext) {
    return refuse('offer-box-open')
  }
  const domain = encodeText(`${HOST_MESH_OFFER_DOMAIN}\0`)
  if (!equalBytes(plaintext.slice(0, domain.byteLength), domain)) {
    return refuse('offer-domain')
  }
  let text: string
  try {
    text = strictUtf8.decode(plaintext.slice(domain.byteLength))
  } catch {
    return refuse('offer-payload-encoding')
  }
  const payload = parseHostMeshOfferPayload(text)
  if (!payload) {
    return refuse('offer-payload-shape')
  }
  if (payload.recipientHostKey !== args.recipientHostKey) {
    return refuse('offer-payload-recipient')
  }
  if (payload.minterHostKey !== sealed.senderHostKey) {
    return refuse('offer-payload-minter')
  }
  if (payload.expiresAt <= args.now) {
    return refuse('offer-expired')
  }
  return payload
}

/** The canonical host key of a raw X25519 public key: the digest peers publish, so both sides agree. */
function hostKeyOf(publicKey: Uint8Array): string {
  return orcaHostKeyOf(Buffer.from(publicKey).toString('base64'))
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isEpoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * Why byte-identical: the minter serialises with `JSON.stringify`, so one encoding is the only one this
 * machine accepts and two boxes carrying the same offer are comparable without parsing twice.
 */
function parseHostMeshOfferPayload(text: string): HostMeshOfferPayload | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null
  }
  const record = parsed as Record<string, unknown>
  if (
    Object.keys(record).length !== PAYLOAD_FIELDS.length ||
    !PAYLOAD_FIELDS.every((field) => Object.hasOwn(record, field)) ||
    record.version !== HOST_MESH_PAYLOAD_VERSION
  ) {
    return null
  }
  const { groupId, epoch, minterHostKey, recipientHostKey, introducedBy, offerUrl } = record
  const { endpointCandidates, expiresAt, nonce } = record
  if (
    !isNonEmptyString(groupId) ||
    !isNonEmptyString(minterHostKey) ||
    !isNonEmptyString(recipientHostKey) ||
    !isNonEmptyString(introducedBy) ||
    !isNonEmptyString(offerUrl) ||
    !isNonEmptyString(nonce) ||
    !isEpoch(epoch) ||
    !isEpoch(expiresAt) ||
    !Array.isArray(endpointCandidates) ||
    endpointCandidates.length > HOST_MESH_MAX_ENDPOINT_CANDIDATES ||
    !endpointCandidates.every(isNonEmptyString)
  ) {
    return null
  }
  if (JSON.stringify(record) !== text) {
    return null
  }
  return {
    version: HOST_MESH_PAYLOAD_VERSION,
    groupId,
    epoch,
    minterHostKey,
    recipientHostKey,
    introducedBy,
    offerUrl,
    endpointCandidates,
    expiresAt,
    nonce
  }
}
