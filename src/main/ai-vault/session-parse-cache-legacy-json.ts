// Retain JSON import until supported upgrades no longer include the old writer.
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  SESSION_PARSE_CACHE_SCHEMA_VERSION,
  parsePersistedSessionParseCacheRow,
  type SessionParseCacheDatabase
} from './session-parse-cache-database'
import type { PersistedSessionParseCacheEntry } from './session-parse-cache-store'

// Match the old writer's maximum file size.
const LEGACY_MAX_BYTES = 64 * 1024 * 1024
// Only the current schema is admitted, because a row replayed from an older one keeps a parser's old
// semantics: rows match on mtime + size, so a finished transcript never changes and the wrong row
// stays wrong for good. 4 carries the `<current_datetime>` prefix as a Copilot title, 5 carries
// `subagent: null` (every Pi sub-agent at top level), and 6 predates 7 (re-read hidden-cached Codex
// threads) and 8 (list pi/omp chats in a shared folder) — each of which the current version must apply.
//
// Why the branch still exists when a matching file is unlikely: no build wrote a current-schema JSON
// file, so this now only deletes the retired file. Keeping the shape means a future writer that ships
// the same schema is read rather than dropped, and the file is removed either way.
const LEGACY_JSON_SCHEMA_VERSIONS: readonly number[] = [SESSION_PARSE_CACHE_SCHEMA_VERSION]

/** Import before live I/O so newer or deleted rows cannot be overwritten; existing database rows win. */
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
    // Unreadable legacy caches fall back to a cold scan.
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
