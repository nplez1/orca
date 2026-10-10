import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'

/**
 * What this host holds *because it was replicated to it*, as opposed to what its user configured.
 *
 * Why this is persisted rather than derived: a snapshot cannot clean up after a revocation without
 * knowing which credentials arrived from the main. The host's own credential stores also hold values
 * the user entered here, and a snapshot that removed anything not in it would delete those. And
 * without the record, a host restart looks like a host that has never synced, which is the normal
 * state of the machine this feature is for.
 */
export type HostSettingsReplicationHoldings = {
  read(): string[]
  write(ids: readonly string[]): void
}

const HOLDINGS_FILE_NAME = 'host-settings-replicated-credentials.json'

/** In-memory, for a test and for a host whose app environment is not up yet. */
export function createInMemoryHostSettingsReplicationHoldings(): HostSettingsReplicationHoldings {
  let ids: string[] = []
  return {
    read: () => ids,
    write: (next) => {
      ids = [...next]
    }
  }
}

export function createFileHostSettingsReplicationHoldings(
  userDataPath: string = getAppEnvironment().getPath('userData')
): HostSettingsReplicationHoldings {
  const path = join(userDataPath, HOLDINGS_FILE_NAME)
  return {
    read: () => {
      if (!existsSync(path)) {
        return []
      }
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf-8'))
        return Array.isArray(parsed?.ids)
          ? parsed.ids.filter((id: unknown): id is string => typeof id === 'string')
          : []
      } catch {
        // Why empty rather than throwing: a corrupt record costs one redundant snapshot, while a throw
        // here would take the RPC method down and read to the main as an unreachable host.
        return []
      }
    },
    write: (ids) => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify({ version: 1, ids: [...ids] }, null, 2), {
        encoding: 'utf-8',
        mode: 0o600
      })
    }
  }
}
