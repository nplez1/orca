import type { AiVaultListResult, AiVaultSession } from '../../../../shared/ai-vault-types'
import { applyAiVaultListDelta } from '../../../../shared/ai-vault-list-sync'

/**
 * The lists this browser tab already holds, per request identity, so a refresh can ask the paired
 * host for the difference instead of re-downloading a multi-megabyte history over the relay.
 */
type HeldBrowserList = {
  fingerprint: string
  sessions: readonly AiVaultSession[]
  issues: AiVaultListResult['issues']
}

/** The panel shows one list per scope; a couple of scopes are enough to keep a switch instant. */
const MAX_HELD_LISTS = 4

const heldLists = new Map<string, HeldBrowserList>()

export function browserHeldAiVaultList(key: string): HeldBrowserList | null {
  const held = heldLists.get(key)
  if (!held) {
    return null
  }
  heldLists.delete(key)
  heldLists.set(key, held)
  return held
}

export function rememberBrowserAiVaultList(key: string, result: AiVaultListResult): void {
  if (!result.fingerprint) {
    return
  }
  heldLists.delete(key)
  heldLists.set(key, {
    fingerprint: result.fingerprint,
    sessions: result.sessions,
    issues: result.issues
  })
  while (heldLists.size > MAX_HELD_LISTS) {
    const oldest = heldLists.keys().next().value
    if (oldest === undefined) {
      break
    }
    heldLists.delete(oldest)
  }
}

export function forgetBrowserAiVaultList(key: string): void {
  heldLists.delete(key)
}

/** The full list this tab holds, rebuilt from the host's changes to it. */
export function applyHeldBrowserAiVaultDelta(
  held: HeldBrowserList,
  reply: AiVaultListResult
): AiVaultListResult {
  return {
    sessions: applyAiVaultListDelta(
      held.sessions,
      reply.syncDelta ?? { upserts: [], removedIds: [] }
    ),
    // Issues describe the current scan, so they come from the reply rather than the held list.
    issues: reply.issues,
    scannedAt: reply.scannedAt,
    ...(reply.fingerprint ? { fingerprint: reply.fingerprint } : {})
  }
}

/** The body this tab already holds, restamped with a reply that says nothing changed. */
export function reusedBrowserAiVaultList(
  held: HeldBrowserList,
  reply: AiVaultListResult
): AiVaultListResult {
  return {
    sessions: [...held.sessions],
    issues: held.issues,
    scannedAt: reply.scannedAt,
    ...(reply.fingerprint ? { fingerprint: reply.fingerprint } : {})
  }
}

export function resetBrowserAiVaultListSyncForTests(): void {
  heldLists.clear()
}
