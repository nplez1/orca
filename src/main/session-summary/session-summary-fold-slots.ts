// Process-wide fold capacity, shared by every open pane.
//
// Why a second limit on top of the per-fold chunk limit: one fold runs per open pane (lease cap
// 512), and every chunk of every fold spawns an agent CLI. Bounding only the chunks still leaves
// panes × chunks processes; this box has already taken a Jetsam kill from a swarm of them.

/** Chunks inside one fold; four agent CLIs is what this box starts at once. */
export const SESSION_SUMMARY_FOLD_CHUNK_CONCURRENCY = 4

/** Folds running at once across every pane. */
export const SESSION_SUMMARY_CONCURRENT_FOLDS = 2

type FoldWaiter = { grant: () => void; cancel: () => void }

let activeFolds = 0
const waiters: FoldWaiter[] = []

/** Resolves once a slot is held, so every caller must pair it with a release. */
export async function acquireSessionSummaryFoldSlot(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  if (activeFolds < SESSION_SUMMARY_CONCURRENT_FOLDS) {
    activeFolds += 1
    return
  }
  await new Promise<void>((resolve, reject) => {
    const waiter: FoldWaiter = { grant, cancel }
    function grant(): void {
      signal.removeEventListener('abort', cancel)
      resolve()
    }
    function cancel(): void {
      const index = waiters.indexOf(waiter)
      if (index !== -1) {
        waiters.splice(index, 1)
      }
      reject(signal.reason instanceof Error ? signal.reason : new Error('fold aborted'))
    }
    waiters.push(waiter)
    signal.addEventListener('abort', cancel, { once: true })
  })
}

/** Hands the slot to the oldest waiter instead of dropping the count, so a queue cannot starve. */
export function releaseSessionSummaryFoldSlot(): void {
  const next = waiters.shift()
  if (next) {
    next.grant()
    return
  }
  activeFolds = Math.max(0, activeFolds - 1)
}

/** Test-only: a leaked slot would otherwise outlive the suite that leaked it. */
export function resetSessionSummaryFoldSlotsForTests(): void {
  activeFolds = 0
  waiters.length = 0
}
