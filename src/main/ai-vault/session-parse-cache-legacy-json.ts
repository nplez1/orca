// Temporary: imports the single JSON file that builds before the per-row
// database wrote, so the first launch after updating re-reads nothing. Remove
// once no supported upgrade path starts from a build that wrote that file.
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  parsePersistedSessionParseCacheRow,
  type SessionParseCacheDatabase
} from './session-parse-cache-database'
import type { PersistedSessionParseCacheEntry } from './session-parse-cache-store'

// The limit the old writer kept the file within.
const LEGACY_MAX_BYTES = 64 * 1024 * 1024
// Only schema 6 is admitted, because this file's directory is Orca NP's own — every build that ever
// wrote it was a fork build, so upstream's JSON schemas never appear here. 4 and 5 are rejected on
// purpose, each for the fault 6 exists to fix: a 4 row carries the `<current_datetime>` prefix as a
// Copilot session title, and a 5 row carries `subagent: null`, which would leave every Pi sub-agent
// transcript at top level. Rows are matched on mtime + size, so a replayed-wrong row is wrong until
// the transcript changes.
const LEGACY_JSON_SCHEMA_VERSIONS: readonly number[] = [6]

/**
 * Runs when the database opens, before any lookup or write can reach it, so a
 * delete can't be undone and an early title lookup can't make the import look
 * done. Synchronous: it happens once per profile, in the scanner child. Rows
 * already in the database win; the file (and any temp file a crashed save
 * left) is deleted whether or not it parsed.
 */
export function importLegacySessionParseCacheJson(
  filePath: string,
  database: SessionParseCacheDatabase,
  seenAt: number
): void {
  try {
    if (statSync(filePath).size <= LEGACY_MAX_BYTES) {
      database.write(readLegacyEntries(readFileSync(filePath, 'utf8')), seenAt, true)
    }
  } catch {
    // Missing, corrupt or foreign: the worst case is a cold scan.
  }
  removeLegacyFiles(filePath)
}

function readLegacyEntries(text: string): [string, PersistedSessionParseCacheEntry][] {
  const parsed: unknown = JSON.parse(text)
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('schemaVersion' in parsed) ||
    typeof parsed.schemaVersion !== 'number' ||
    !LEGACY_JSON_SCHEMA_VERSIONS.includes(parsed.schemaVersion) ||
    !('entries' in parsed) ||
    !Array.isArray(parsed.entries)
  ) {
    return []
  }
  return parsed.entries.flatMap((item: unknown) => {
    const entry = parsePersistedSessionParseCacheRow(item)
    return entry === null ? [] : [entry]
  })
}

function removeLegacyFiles(filePath: string): void {
  const directory = dirname(filePath)
  let names: string[] = []
  try {
    names = readdirSync(directory)
  } catch {
    return
  }
  for (const name of names) {
    if (
      name === basename(filePath) ||
      (name.startsWith('session-parse-cache-') && name.endsWith('.tmp'))
    ) {
      try {
        rmSync(join(directory, name), { force: true })
      } catch {
        // Retried on the next open.
      }
    }
  }
}
