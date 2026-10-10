import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'

/**
 * What this host holds *because it was replicated to it*, and where its replication had got to.
 *
 * - `ids` is why this is persisted rather than derived: a snapshot cannot clean up after a revocation
 *   without knowing which credentials arrived from the main, and the host's own stores also hold what
 *   the user entered here, which a snapshot must never touch.
 * - `revision` and `syncedAt` are persisted so a restarted host is not a host that has never synced —
 *   the main being asleep is the normal state of the machine this feature is for, and a host that
 *   forgot its revision would take a full snapshot on every reconnect.
 * - `mainFingerprint` is the first paired caller to send a snapshot. Without it, any paired desktop
 *   could push removals at a host configured by another one, and the two would fight.
 */
export type HostSettingsReplicationRecord = {
  ids: string[]
  revision: number | null
  syncedAt: number | null
  mainFingerprint: string | null
}

export type HostSettingsReplicationHoldings = {
  read(): HostSettingsReplicationRecord
  write(next: HostSettingsReplicationRecord): void
}

export const EMPTY_HOST_SETTINGS_REPLICATION_RECORD: HostSettingsReplicationRecord = {
  ids: [],
  revision: null,
  syncedAt: null,
  mainFingerprint: null
}

/** In-memory, for a test and for a host whose app environment is not up yet. */
export function createInMemoryHostSettingsReplicationHoldings(
  initial: HostSettingsReplicationRecord = EMPTY_HOST_SETTINGS_REPLICATION_RECORD
): HostSettingsReplicationHoldings {
  let record = initial
  return {
    read: () => record,
    write: (next) => {
      record = next
    }
  }
}

const HOLDINGS_FILE_NAME = 'host-settings-replicated-credentials.json'

export function createFileHostSettingsReplicationHoldings(
  userDataPath: string = getAppEnvironment().getPath('userData')
): HostSettingsReplicationHoldings {
  const path = join(userDataPath, HOLDINGS_FILE_NAME)
  return {
    read: () => {
      if (!existsSync(path)) {
        return EMPTY_HOST_SETTINGS_REPLICATION_RECORD
      }
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf-8'))
        return {
          ids: Array.isArray(parsed?.ids)
            ? parsed.ids.filter((id: unknown): id is string => typeof id === 'string')
            : [],
          revision: typeof parsed?.revision === 'number' ? parsed.revision : null,
          syncedAt: typeof parsed?.syncedAt === 'number' ? parsed.syncedAt : null,
          mainFingerprint:
            typeof parsed?.mainFingerprint === 'string' ? parsed.mainFingerprint : null
        }
      } catch {
        // Why empty rather than throwing: a corrupt record costs one redundant snapshot, while a throw
        // here would take the RPC method down and read to the main as an unreachable host.
        return EMPTY_HOST_SETTINGS_REPLICATION_RECORD
      }
    },
    write: (next) => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify({ version: 1, ...next }, null, 2), {
        encoding: 'utf-8',
        mode: 0o600
      })
    }
  }
}
