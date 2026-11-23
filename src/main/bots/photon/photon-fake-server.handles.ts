// What the fake provider does to a handle before storing it.

/** A phone number or Apple-ID email in the form the provider stores it. */
export function normaliseHandle(handle: string): string {
  const trimmed = handle.trim().toLowerCase()
  if (trimmed.includes('@')) {
    return trimmed
  }
  const digits = trimmed.replace(/[^0-9]/g, '')
  return digits.length === 0 ? trimmed : `+1${digits.replace(/^1/, '')}`
}
