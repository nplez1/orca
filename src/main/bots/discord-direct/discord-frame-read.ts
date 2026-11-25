/**
 * Reading a field off a gateway frame.
 *
 * Why outside the state machine: a frame arrives as `unknown`, and the only safe way to look inside is
 * a copy-then-index that needs no cast. Keeping that here keeps the connection logic readable, and the
 * state machine has a line budget.
 */

export function readField(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') {
    return undefined
  }
  const fields: Record<string, unknown> = {}
  return Object.assign(fields, value)[key]
}

export function readString(value: unknown, key: string): string | undefined {
  const field = readField(value, key)
  return typeof field === 'string' ? field : undefined
}
