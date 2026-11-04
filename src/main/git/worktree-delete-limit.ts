// Use a separate two-delete queue: long disk-bound removals must not occupy general Git read slots.
export const WORKTREE_DELETE_CONCURRENCY = 2

/** A queued delete must give up rather than wait behind two wedged ones for the rest of the session. */
export const WORKTREE_DELETE_QUEUE_TIMEOUT_MS = 5 * 60_000

type QueueTicket = {
  grant: () => void
  /** Set only by release, so a give-up that lost the race can hand the slot straight on. */
  granted: boolean
}

let running = 0
const waiting: QueueTicket[] = []

export type WorktreeDeleteLimitOptions = {
  /** Abandons the queue wait when the checkout delete is cancelled. */
  signal?: AbortSignal
  waitMs?: number
}

export async function runUnderWorktreeDeleteLimit<T>(
  operation: () => Promise<T>,
  options: WorktreeDeleteLimitOptions = {}
): Promise<T> {
  await acquireDeleteSlot(options)
  try {
    return await operation()
  } finally {
    releaseDeleteSlot()
  }
}

function releaseDeleteSlot(): void {
  const next = waiting.shift()
  if (!next) {
    running -= 1
    return
  }
  // Hand off directly so new arrivals cannot overtake queued deletes.
  next.granted = true
  next.grant()
}

async function acquireDeleteSlot(options: WorktreeDeleteLimitOptions): Promise<void> {
  options.signal?.throwIfAborted()
  if (running < WORKTREE_DELETE_CONCURRENCY) {
    running += 1
    return
  }
  const ticket: QueueTicket = { granted: false, grant: () => {} }
  const granted = new Promise<void>((resolve) => {
    ticket.grant = resolve
  })
  waiting.push(ticket)
  if (await waitForSlot(granted, options)) {
    return
  }
  // Hand the slot on when the give-up lost the race; otherwise leave the queue as it was.
  if (ticket.granted) {
    releaseDeleteSlot()
  } else {
    const queuedAt = waiting.indexOf(ticket)
    if (queuedAt !== -1) {
      waiting.splice(queuedAt, 1)
    }
  }
  throw options.signal?.aborted
    ? Object.assign(new Error('Workspace deletion was cancelled while queued.'), {
        name: 'AbortError'
      })
    : new Error(
        `Timed out waiting for another workspace delete to finish after ${Math.round(
          (options.waitMs ?? WORKTREE_DELETE_QUEUE_TIMEOUT_MS) / 1_000
        )}s. Retry deletion.`
      )
}

/** Resolves true when the slot arrived first, false when the wait was abandoned. */
function waitForSlot(
  granted: Promise<void>,
  options: WorktreeDeleteLimitOptions
): Promise<boolean> {
  const waitMs = options.waitMs ?? WORKTREE_DELETE_QUEUE_TIMEOUT_MS
  const signal = options.signal
  return new Promise<boolean>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const settle = (slotArrived: boolean): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abandon)
      resolve(slotArrived)
    }
    function abandon(): void {
      settle(false)
    }
    timer = setTimeout(abandon, waitMs)
    signal?.addEventListener('abort', abandon, { once: true })
    void granted.then(() => settle(true))
  })
}

export function _worktreeDeleteLimitSnapshotForTests(): { running: number; waiting: number } {
  return { running, waiting: waiting.length }
}
