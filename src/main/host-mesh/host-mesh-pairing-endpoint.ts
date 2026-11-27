import {
  PersistedRuntimeEnvironmentSchema,
  preferredEndpoint
} from '../../shared/remote-runtime/host-catalog/runtime-environments'
import {
  readPersistedEnvironmentStore,
  writeEnvironmentStore
} from '../../shared/remote-runtime/host-store/runtime-environment-store-file'
import { resolveEnvironmentFromStore } from '../../shared/remote-runtime/host-store/runtime-environment-selection'

/**
 * Points a pairing row at a new address, keeping its credential and its pairing revision.
 *
 * Why not `updateEnvironmentFromPairingCode`: that rebuilds the row as a fresh pairing and raises
 * `pairingRevision`, which is the number worker stop/observe and the automation owner keys pin — an address-only
 * move would read as a different machine. Why the rewrite goes through the store file and not the RPC surface: a
 * pairing row is a synchronous write, and this runs inside a pass that must not stall the main process.
 *
 * Returns false when the row cannot be moved, which is the caller's cue that its address is not what changed.
 */
export function relocatePairingEndpoint(args: {
  userDataPath: string
  environmentId: string
  endpoint: string
  now: number
}): boolean {
  try {
    const store = readPersistedEnvironmentStore(args.userDataPath)
    const existing = resolveEnvironmentFromStore(store, args.environmentId)
    const preferred = preferredEndpoint(existing)
    if (preferred.endpoint === args.endpoint) {
      return true
    }
    // Why the endpoint entry and not the row: its id, token and public key are the pairing, and only the address
    // moved — so the credential the pair was made with stays the one every dial uses.
    const next = PersistedRuntimeEnvironmentSchema.parse({
      ...existing,
      updatedAt: args.now,
      endpoints: existing.endpoints.map((entry) =>
        entry.id === preferred.id ? { ...entry, endpoint: args.endpoint } : entry
      )
    })
    writeEnvironmentStore(args.userDataPath, {
      version: 1,
      environments: store.environments
        .map((entry) => (entry.id === existing.id ? next : entry))
        .sort((left, right) => left.name.localeCompare(right.name))
    })
    return true
  } catch {
    return false
  }
}
