import type { ReplicatedHostCredential } from '../../shared/host-settings-replication'
import type { SecretAtRestProtection } from '../../shared/secure-storage/secret-at-rest-protection'
import type { Awaitable, HostSettingsCredentialPort } from './host-settings-credential-port'

/** What a provider key store has to expose for {@link createHostSettingsApiKeyPort} to adapt it. */
export type HostSettingsApiKeyStore = {
  has(): Awaitable<boolean>
  read(): Awaitable<string | null>
  save(key: string): Awaitable<void>
  clear(): Awaitable<void>
  protection(): Awaitable<SecretAtRestProtection | null>
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
  const readPayload = async (): Promise<string | null> => {
    try {
      return await store.read()
    } catch {
      return null
    }
  }

  const protectionOf = async (credentialId: string): Promise<SecretAtRestProtection | null> => {
    if (credentialId !== id || !(await store.has())) {
      return null
    }
    // Why default to plaintext: an undecodable envelope is still readable bytes on disk, and this
    // value is only ever compared against a sender's `sealed` to refuse a downgrade.
    return (await store.protection()) ?? 'plaintext'
  }

  return {
    kind,
    canSeal,
    protectionOf,
    unreadableIds: async () => ((await store.has()) && (await readPayload()) === null ? [id] : []),
    list: async () => {
      const protection = await protectionOf(id)
      if (protection === null) {
        return []
      }
      const payload = await readPayload()
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
    apply: async (credential) => {
      await store.save(credential.payload)
    },
    remove: async (credentialId) => {
      if (credentialId === id) {
        await store.clear()
      }
    }
  }
}
