import type { ReplicatedHostCredential } from '../../shared/host-settings-replication'
import type { SecretAtRestProtection } from '../../shared/secret-at-rest-protection'
import type { HostSettingsCredentialPort } from './host-settings-credential-port'

/** What a provider key store has to expose for {@link createHostSettingsApiKeyPort} to adapt it. */
export type HostSettingsApiKeyStore = {
  has(): boolean
  read(): string | null
  save(key: string): void
  clear(): void
  protection(): SecretAtRestProtection | null
}

/**
 * Adapt a single-key provider store to the replication port.
 *
 * Why presence comes from `has()` and not from `protection()`: `protection()` answers null for a
 * file that is there but cannot be decoded, and treating that as "nothing stored" would let a
 * revocation report `removed` while the ciphertext is still on disk.
 */
export function createHostSettingsApiKeyPort(input: {
  kind: string
  id: string
  label: string
  store: HostSettingsApiKeyStore
  canSeal: () => boolean
}): HostSettingsCredentialPort {
  const { kind, id, label, store, canSeal } = input

  // Why swallowed: listing runs to build one payload of many credentials, and a key this host cannot
  // decrypt is one it cannot send — it must not stop the rest, and it must be reported as unreadable
  // rather than as absent, because absent means deleted to the other end.
  const readPayload = (): string | null => {
    try {
      return store.read()
    } catch {
      return null
    }
  }

  const protectionOf = (credentialId: string): SecretAtRestProtection | null => {
    if (credentialId !== id || !store.has()) {
      return null
    }
    // Why default to plaintext: an undecodable envelope is still readable bytes on disk, and this
    // value is only ever compared against a sender's `sealed` to refuse a downgrade.
    return store.protection() ?? 'plaintext'
  }

  return {
    kind,
    canSeal,
    protectionOf,
    unreadableIds: () => (store.has() && readPayload() === null ? [id] : []),
    list: () => {
      const protection = protectionOf(id)
      if (protection === null) {
        return []
      }
      const payload = readPayload()
      if (payload === null) {
        return []
      }
      const credential: ReplicatedHostCredential = {
        id,
        kind,
        label,
        protection,
        onlyIfEmpty: false,
        payload
      }
      return [credential]
    },
    apply: (credential) => {
      store.save(credential.payload)
    },
    remove: (credentialId) => {
      if (credentialId === id) {
        store.clear()
      }
    }
  }
}
