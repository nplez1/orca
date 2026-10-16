import { isOrcaYamlFieldWithinLimit } from './orca-yaml-file-limit'

/** Field coercions shared by every `orca.yaml` reader. */

/** A mapping, or null for every other YAML value (including arrays and null). */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** A trimmed non-empty string within the per-field limit, or undefined for anything else. */
export function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string' || !isOrcaYamlFieldWithinLimit(value)) {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed || undefined
}
