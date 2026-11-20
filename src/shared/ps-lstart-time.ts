import { psLocaleEnvironment } from './process-observation/tables/ps-locale-environment'

/** `lstart` is local wall clock, and the hour a DST fall-back repeats parses an hour early: read it in
 * UTC so a start time is one instant. `runPsInProcess` formats its own rows for the same zone. */
export function psUtcEnvironment(): NodeJS.ProcessEnv {
  return { ...(psLocaleEnvironment() ?? process.env), TZ: 'UTC' }
}

/** `lstart` text read under `psUtcEnvironment()` is UTC, and `Date.parse` reads a zone-less string as local. */
export function parseUtcLstart(text: string): number {
  return Date.parse(`${text.trim()} UTC`)
}

/** A zone token, optionally followed by its parenthetical name, as `Date.toString()` writes it. */
const NAMES_ITS_ZONE = /(?:Z|[+-]\d{2}:?\d{2}|GMT|UTC)(?:\s*\([^)]*\))?\s*$/i

/** One start instant from either shape a start time takes: zone-less UTC `lstart` or an ISO stamp. */
export function parsePsStartTime(startedAt: string): number {
  const trimmed = startedAt.trim()
  // Text that names its zone is already one instant, and appending `UTC` after the parenthetical —
  // `GMT-0800 (Pacific Standard Time)` — then parses hours early, which authorizes signalling a
  // recycled PID.
  return NAMES_ITS_ZONE.test(trimmed) ? Date.parse(trimmed) : parseUtcLstart(trimmed)
}
