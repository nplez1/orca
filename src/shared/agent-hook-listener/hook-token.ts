import { timingSafeEqual } from 'node:crypto'

/**
 * Constant-time comparison of a hook token request header against the token this listener minted.
 *
 * Why: `!==` returns as soon as two strings differ, so the comparison time leaks how much of the token
 * a caller guessed. Only local processes can reach either listener and the token is a random UUID, so
 * this is hardening rather than a live hole — it costs one buffer allocation per request.
 *
 * Why lengths are compared first: `timingSafeEqual` throws on a length mismatch, which would turn a
 * short guess into a failed request instead of a 403. Only the token's length leaks, and a UUID's is
 * fixed by construction.
 */
export function hookTokenMatches(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string' || expected.length === 0) {
    return false
  }
  const given = Buffer.from(provided, 'utf8')
  const want = Buffer.from(expected, 'utf8')
  return given.length === want.length && timingSafeEqual(given, want)
}
