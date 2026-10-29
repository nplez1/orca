// A failure a catch handled by returning a fallback is still evidence; this is where it goes so a
// diagnostic bundle carries it, instead of only the console of the process that happened to log it.

import { startSpan } from './tracer'

/**
 * Record a failure a caller absorbed by falling back — `[]`, `null`, a skipped item, a degraded mode.
 *
 * `subsystem` is the short bracket name the call site already logs under (`jira`, `session-summary`),
 * and `detail` names the operation that failed so a trace line reads without the source beside it.
 * `level` keeps the console severity the call site had: a store that could not be read is an error,
 * a degraded readout is a warning, and tests and log readers already draw that line.
 *
 * Why the console line stays: a dev build and a diagnostics-disabled one have no sink, and losing the
 * message there would trade one blind spot for another. A sink adds the persistent copy, it does not
 * replace the local one.
 */
export function recordSwallowedFailure(
  subsystem: string,
  error: unknown,
  detail?: string,
  level: 'warn' | 'error' = 'warn'
): void {
  console[level](`[${subsystem}] ${detail ?? 'swallowed failure'}:`, error)
  startSpan('swallowed-failure', {
    attributes: { subsystem, ...(detail ? { detail } : {}) }
  }).fail(error instanceof Error ? error : String(error))
}
