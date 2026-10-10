import { getSecretStore } from '../../shared/secret-store'
import type { ReplicatedHostCredential } from '../../shared/host-settings-replication'
import type { SecretAtRestProtection } from '../../shared/secret-at-rest-protection'

/**
 * One credential family as the host holding it sees it.
 *
 * Why this narrow: the replication core never learns what a Jira site or an API key looks like on
 * disk, so a new provider is a new adapter rather than another branch in the core, and the core's
 * policy — never downgrade protection, never overwrite a deliberate local value — is expressed once.
 */
export type HostSettingsCredentialPort = {
  /** Matches `ReplicatedHostCredential.kind`. */
  kind: string
  /** Everything this host could send. Empty when it holds none. */
  list(): ReplicatedHostCredential[]
  /** Whether this host can store a value sealed at rest at all. */
  canSeal(): boolean
  /** How the value sits on this host, or null when it holds none. */
  protectionOf(id: string): SecretAtRestProtection | null
  apply(credential: ReplicatedHostCredential): void
  remove(id: string): void
}

export type HostSettingsCredentialRegistry = {
  /** The adapter that owns a credential id, or undefined when this build has none. */
  forCredentialId(id: string): HostSettingsCredentialPort | undefined
}

/**
 * Whether this host can actually protect a secret at rest, not merely call an encryptor.
 *
 * Why not `safeStorage.isEncryptionAvailable()` alone: on Linux with the `basic_text` backend that
 * answers true and encrypts with a fixed, published key, which is not protection. Every port has to
 * answer the same question the same way, or a store that can only write plaintext would report that
 * it can seal and defeat the refusal the replication policy is built on.
 */
export function canSealReplicatedCredential(): boolean {
  const store = getSecretStore()
  return store.isEncryptionAvailable() && store.describeProtectionGap() === null
}

/**
 * A credential id is `<kind>` or `<kind>:<local>`, so the registry resolves an id — including a
 * removal, which carries no kind — back to its adapter.
 *
 * Why longest kind first: nothing stops one kind being a prefix of another, and the adapter that
 * resolves an id must be the most specific one.
 */
export function createHostSettingsCredentialRegistry(
  ports: readonly HostSettingsCredentialPort[]
): HostSettingsCredentialRegistry {
  const ordered = [...ports].sort((left, right) => right.kind.length - left.kind.length)
  return {
    forCredentialId: (id) =>
      ordered.find((port) => id === port.kind || id.startsWith(`${port.kind}:`))
  }
}
