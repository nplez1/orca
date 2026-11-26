import type { KnownRuntimeEnvironment } from '../host-catalog/runtime-environments'
import { findCollidingEnvironmentName } from '../host-catalog/runtime-environment-name-collision'
import { resolveEnvironmentFromStore } from './runtime-environment-selection'
import {
  readPersistedEnvironmentStore,
  writeEnvironmentStore
} from './runtime-environment-store-file'
import {
  RuntimeEnvironmentStoreError,
  remoteServerPairingStoreError
} from './runtime-environment-store-records'

/**
 * Renaming a saved server, kept apart from the pairing operations.
 *
 * Why its own module: a rename writes a name and nothing else, while everything beside it parses an offer and writes
 * a credential — and a name arriving from the mesh is the one caller that must not fail on a local collision.
 */

export type RenameEnvironmentArgs = {
  name: string
  now?: number
  /**
   * Why a rename may disambiguate: a mesh name arrives from another machine, and two machines both called "Mac mini"
   * are a fact about the fleet rather than a mistake to refuse — the alternative is a row stuck on a host key.
   */
  disambiguate?: boolean
}

/** Renames a saved server in place, keeping its id, pairing and history. */
export function renameEnvironment(
  userDataPath: string,
  selector: string,
  args: RenameEnvironmentArgs
): KnownRuntimeEnvironment {
  const store = readPersistedEnvironmentStore(userDataPath)
  const existing = resolveEnvironmentFromStore(store, selector)
  const wanted = args.name.trim()
  if (wanted === '') {
    throw new RuntimeEnvironmentStoreError('runtime_error', 'A server name cannot be empty.')
  }
  const others = store.environments.filter((entry) => entry.id !== existing.id)
  const name = args.disambiguate === true ? uniqueEnvironmentName(others, wanted) : wanted
  const collision = findCollidingEnvironmentName(others, name)
  if (collision) {
    throw remoteServerPairingStoreError('nameTaken', { name: collision.name })
  }
  if (name === existing.name) {
    return existing
  }
  const next = { ...existing, name, updatedAt: args.now ?? Date.now() }
  writeEnvironmentStore(userDataPath, {
    version: 1,
    environments: store.environments
      .map((entry) => (entry.id === existing.id ? next : entry))
      .sort((a, b) => a.name.localeCompare(b.name))
  })
  return next
}

/** `Mac mini`, then `Mac mini (2)`, since a fleet can legitimately hold two machines with one name. */
export function uniqueEnvironmentName(
  environments: readonly { name: string }[],
  wanted: string
): string {
  if (!findCollidingEnvironmentName(environments, wanted)) {
    return wanted
  }
  for (let suffix = 2; suffix <= environments.length + 2; suffix += 1) {
    const candidate = `${wanted} (${suffix})`
    if (!findCollidingEnvironmentName(environments, candidate)) {
      return candidate
    }
  }
  return wanted
}
