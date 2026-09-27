/**
 * Readers for Jenkins' REST payloads.
 *
 * Jenkins answers with a loosely-typed, version-dependent JSON document, so every field is read
 * defensively: a missing or reshaped field degrades one row of the pane rather than throwing on a
 * payload we do not control.
 */

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: guarded above; `in`/index access on unknown needs a record view.
  return value as Record<string, unknown>
}

export function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function isoFromMs(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString()
}

/** Jenkins statuses are upper-case and mix `FAILURE` (build) with `FAILED` (stage). */
export function normalizeJenkinsState(value: unknown): string | null {
  return readString(value)?.toUpperCase() ?? null
}
