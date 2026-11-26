import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { machineRefOf, orcaHostKeyOf, sshHostKeyFingerprintOf } from './host-graph-self-identity'

// A real ed25519 host key line, so the test exercises the same bytes sshd publishes.
const ED25519_PUBLIC_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ8pQ2nJ5m0m0dQ1cQxqKk0mQ0rq9n3kZx0j0k3i8xYz orca@test'

describe('this machine’s own identity', () => {
  it('derives the pairing digest both sides compare', () => {
    const publicKeyB64 = 'AAAAexample+key/with==padding'

    expect(orcaHostKeyOf(publicKeyB64)).toBe(
      createHash('sha256').update(publicKeyB64).digest('hex').slice(0, 32)
    )
  })

  it('fingerprints the key blob, which is what the host-key store records for a peer', () => {
    const blob = ED25519_PUBLIC_KEY.split(' ')[1]
    const expectedBase64 = createHash('sha256').update(Buffer.from(blob, 'base64')).digest('base64')

    expect(sshHostKeyFingerprintOf(ED25519_PUBLIC_KEY)).toBe(
      `SHA256:${expectedBase64.replace(/=+$/, '')}`
    )
  })

  it('ignores a line that carries no key blob', () => {
    expect(sshHostKeyFingerprintOf('ssh-ed25519')).toBeUndefined()
    expect(sshHostKeyFingerprintOf('')).toBeUndefined()
  })

  it('names a machine by whatever keys it actually has', () => {
    const ref = machineRefOf({
      orcaPublicKeyB64: 'pairing-key',
      sshPublicKeyLines: [ED25519_PUBLIC_KEY]
    })

    expect(ref.orcaHostKey).toBe(orcaHostKeyOf('pairing-key'))
    expect(ref.sshHostKeys).toHaveLength(1)
  })

  it('still describes a machine that has neither, rather than throwing', () => {
    expect(machineRefOf({})).toEqual({})
    expect(machineRefOf({ sshPublicKeyLines: ['', 'garbage'] })).toEqual({})
  })
})
