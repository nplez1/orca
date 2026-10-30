import { afterEach, describe, expect, it } from 'vitest'
import { _resetSecretStoreForTests, setSecretStore } from '../../shared/secret-store'
import { canSealReplicatedCredential } from './host-settings-credential-port'
import { HOST_SETTINGS_CREDENTIAL_PORTS } from './host-settings-credential-ports'

/** Only the three answers this policy reads; the encryptor is never reached. */
function stubStore(options: { available?: boolean; gap?: string | null; throws?: boolean }): void {
  setSecretStore({
    isEncryptionAvailable: () => {
      if (options.throws) {
        throw new Error('keyring unavailable')
      }
      return options.available ?? true
    },
    describeProtectionGap: () => options.gap ?? null,
    encryptString: () => Buffer.from(''),
    decryptString: () => ''
  })
}

afterEach(() => {
  _resetSecretStoreForTests()
})

describe('the plaintext-replication refusal', () => {
  it('allows sealing when the store encrypts and reports no protection gap', () => {
    stubStore({})

    expect(canSealReplicatedCredential()).toBe(true)
  })

  // Why the gap is checked at all: on Linux the `basic_text` backend answers that encryption is
  // available while encrypting with a fixed, published key. Calling that "can seal" is how a
  // credential reaches a host as plaintext without the user ever being told.
  it('refuses when the store is available but describes a protection gap', () => {
    stubStore({ gap: 'basic_text: the keyring is a fixed, published key' })

    expect(canSealReplicatedCredential()).toBe(false)
  })

  it('refuses when the store has no encryption at all', () => {
    stubStore({ available: false })

    expect(canSealReplicatedCredential()).toBe(false)
  })

  it('refuses when the store throws instead of asking it twice', () => {
    stubStore({ throws: true })

    expect(canSealReplicatedCredential()).toBe(false)
  })

  // Why every port: the receiver asks the port that owns the credential, so one adapter wired to
  // `isEncryptionAvailable()` alone would defeat the refusal for its own family while the others hold.
  // Why the exported registry: building a port here with `canSeal: canSealReplicatedCredential` and then
  // asking that port would only prove the test passed its own argument.
  it('wires the same answer into every credential port this build replicates', () => {
    stubStore({ available: true, gap: 'basic_text' })
    expect(HOST_SETTINGS_CREDENTIAL_PORTS.map((port) => port.canSeal())).not.toContain(true)
    expect(HOST_SETTINGS_CREDENTIAL_PORTS.length).toBeGreaterThan(0)

    stubStore({ available: true, gap: null })
    expect(HOST_SETTINGS_CREDENTIAL_PORTS.map((port) => port.canSeal())).not.toContain(false)
  })
})
