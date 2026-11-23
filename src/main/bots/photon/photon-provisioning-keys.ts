// The idempotency keys provisioning derives. They live alone because both the saga and its reconciler
// need them: a key that only one of them knew would let a repair mint a second resource beside the one
// that already exists.
import { createHash } from 'node:crypto'

/** Stable across restarts, distinct per bot, so a retried create replays instead of making a second
 *  project that consumes capacity and hands out a second number. */
export function photonCreateKey(botId: string): string {
  return `photon-create-${botId}`
}

/** One key per key generation, so each mint is a distinct request: a mint whose response was lost can
 *  never be replayed onto the same key, which is what left an orphan nothing ever revoked. */
export function photonKeyMintKey(botId: string, generation: number): string {
  return `photon-key-${botId}-${generation}`
}

/** One key per bot generation and handle, so re-provisioning cannot replay a released assignment and
 *  show a number that no longer exists. */
export function photonAssignmentKey(botId: string, generation: number, handle: string): string {
  const digest = createHash('sha256')
    .update(normalisePhotonHandle(handle))
    .digest('hex')
    .slice(0, 16)
  return `photon-assign-${botId}-${generation}-${digest}`
}

export function normalisePhotonHandle(handle: string): string {
  const trimmed = handle.trim().toLowerCase()
  return trimmed.includes('@') ? trimmed : trimmed.replace(/[^0-9+]/g, '')
}
