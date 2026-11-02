import { psLocaleEnvironment } from './ps-locale-environment'

/** `lstart` is local wall clock, and the hour a DST fall-back repeats parses an hour early: read it in
 * UTC so a start time is one instant. `runPsInProcess` formats its own rows for the same zone. */
export function psUtcEnvironment(): NodeJS.ProcessEnv {
  return { ...(psLocaleEnvironment() ?? process.env), TZ: 'UTC' }
}

/** `lstart` text read under `psUtcEnvironment()` is UTC, and `Date.parse` reads a zone-less string as local. */
export function parseUtcLstart(text: string): number {
  return Date.parse(`${text.trim()} UTC`)
}
