import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummarySnapshot } from '../../shared/session-summary-types'
import { SessionSummaryHostFoldSubscription } from './session-summary-host-subscription'

function snapshot(running: boolean, overrides: Partial<SessionSummarySnapshot> = {}) {
  return {
    paneKey: 'tab-1:leaf-1',
    status: running ? ('folding' as const) : ('ready' as const),
    facts: null,
    ledger: null,
    seenThrough: 0,
    fold: { running, completedChunks: 0, totalChunks: 1 },
    ...overrides
  } satisfies SessionSummarySnapshot
}

function harness(overrides: { peek?: () => Promise<SessionSummarySnapshot> } = {}) {
  const snapshots: SessionSummarySnapshot[] = []
  const errors: Error[] = []
  const closed: string[] = []
  const subscription = new SessionSummaryHostFoldSubscription({
    hostFold: {
      open: async () => snapshot(true),
      peek: overrides.peek ?? (async () => snapshot(true)),
      close: async ({ paneKey }) => {
        closed.push(paneKey)
      }
    },
    pollIntervalMs: 1,
    onSnapshot: (_paneKey, next) => snapshots.push(next),
    onError: (_paneKey, error) => errors.push(error)
  })
  return { subscription, snapshots, errors, closed }
}

// The subscription only schedules timers and awaits mocked promises, so fake time drives it
// exactly; advanceTimersByTimeAsync flushes the promise chain between timers.
const advance = async (ms: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms)
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('SessionSummaryHostFoldSubscription', () => {
  it('polls until the host reports the fold settled, then stops', async () => {
    const h = harness({
      peek: async () => snapshot(false)
    })
    h.subscription.open({
      paneKey: 'tab-1:leaf-1',
      environmentId: 'env-1',
      foldParams: null
    })
    await advance(20)
    const seen = h.snapshots.length
    await advance(20)

    expect(h.snapshots.at(-1)?.fold.running).toBe(false)
    expect(h.snapshots.length).toBe(seen)
  })

  // Why one retry: a relay blip must not freeze a stale brief under "Up to date".
  it('retries a failed poll once before reporting it', async () => {
    let calls = 0
    const h = harness({
      peek: async () => {
        calls += 1
        if (calls === 1) {
          throw new Error('relay blip')
        }
        return snapshot(false)
      }
    })
    h.subscription.open({
      paneKey: 'tab-1:leaf-1',
      environmentId: 'env-1',
      foldParams: null
    })
    await advance(30)

    expect(h.errors).toHaveLength(0)
    expect(h.snapshots.at(-1)?.fold.running).toBe(false)
  })

  it('reports a poll failure that persists', async () => {
    const h = harness({
      peek: async () => {
        throw new Error('host unreachable')
      }
    })
    h.subscription.open({
      paneKey: 'tab-1:leaf-1',
      environmentId: 'env-1',
      foldParams: null
    })
    await advance(40)

    expect(h.errors.map((error) => error.message)).toEqual(['host unreachable'])
  })

  it('stops polling and tells the host when the pane closes', async () => {
    let calls = 0
    const h = harness({
      peek: async () => {
        calls += 1
        return snapshot(true)
      }
    })
    h.subscription.open({
      paneKey: 'tab-1:leaf-1',
      environmentId: 'env-1',
      foldParams: null
    })
    await advance(10)
    h.subscription.close({
      paneKey: 'tab-1:leaf-1',
      environmentId: 'env-1',
      seenTimelineCount: 3,
      lastViewer: true
    })
    const seen = calls
    await advance(20)

    expect(calls).toBe(seen)
    expect(h.closed).toEqual(['tab-1:leaf-1'])
  })

  it('drops a late answer from a chain the pane already replaced', async () => {
    const resolveLater: (() => void)[] = []
    const h = harness({
      peek: () =>
        new Promise((resolve) => {
          resolveLater.push(() => resolve(snapshot(true)))
        })
    })
    h.subscription.open({
      paneKey: 'tab-1:leaf-1',
      environmentId: 'env-1',
      foldParams: null
    })
    await advance(10)
    // A reopen replaces the chain while the old poll is in flight.
    h.subscription.open({
      paneKey: 'tab-1:leaf-1',
      environmentId: 'env-1',
      foldParams: null
    })
    for (const resolve of resolveLater.splice(0)) {
      resolve()
    }
    await advance(10)

    expect(h.errors).toHaveLength(0)
  })
})

describe('SessionSummaryHostFoldSubscription lease accounting', () => {
  function richHarness(open: () => Promise<SessionSummarySnapshot>) {
    const opened: string[] = []
    const closed: number[] = []
    const snapshots: SessionSummarySnapshot[] = []
    const errors: Error[] = []
    const subscription = new SessionSummaryHostFoldSubscription({
      hostFold: {
        open: async ({ paneKey }) => {
          opened.push(paneKey)
          return open()
        },
        peek: async () => snapshot(true),
        close: async ({ seenTimelineCount }) => {
          closed.push(seenTimelineCount)
        }
      },
      pollIntervalMs: 1,
      onSnapshot: (_paneKey, next) => snapshots.push(next),
      onError: (_paneKey, error) => errors.push(error)
    })
    return { subscription, opened, closed, snapshots, errors }
  }

  const args = { paneKey: 'tab-1:leaf-1', environmentId: 'env-1', foldParams: null }

  // A viewer can close before the host has answered its open. The lease that open takes must
  // still be closed, or the host's fold never stops.
  it('closes the lease of an open that lands after the close', async () => {
    let resolveOpen: (value: SessionSummarySnapshot) => void = () => {}
    const pending = new Promise<SessionSummarySnapshot>((resolve) => {
      resolveOpen = resolve
    })
    const h = richHarness(() => pending)
    h.subscription.open(args)
    h.subscription.close({
      paneKey: args.paneKey,
      environmentId: args.environmentId,
      seenTimelineCount: 4,
      lastViewer: true
    })
    expect(h.closed).toEqual([])

    resolveOpen(snapshot(false))
    await advance(10)

    expect(h.closed).toEqual([4])
    // The viewer is gone, so the answer must not restart polling.
    await advance(10)
    expect(h.snapshots).toHaveLength(0)
  })

  // A close with no lease to spend waits behind the oldest unanswered open, so two overlapping
  // opens and two closes produce two closes rather than one and a leak.
  it('pairs two overlapping opens with two closes', async () => {
    const resolvers: ((value: SessionSummarySnapshot) => void)[] = []
    const h = richHarness(
      () =>
        new Promise<SessionSummarySnapshot>((resolve) => {
          resolvers.push(resolve)
        })
    )
    h.subscription.open(args)
    h.subscription.open(args)
    h.subscription.close({
      paneKey: args.paneKey,
      environmentId: args.environmentId,
      seenTimelineCount: 1,
      lastViewer: false
    })
    h.subscription.close({
      paneKey: args.paneKey,
      environmentId: args.environmentId,
      seenTimelineCount: 2,
      lastViewer: true
    })
    for (const resolve of resolvers.splice(0)) {
      resolve(snapshot(false))
    }
    await advance(10)

    expect(h.closed.sort()).toEqual([1, 2])
  })

  // Two windows on one paired-host pane: the first to close must not stop the other's polling.
  it('keeps polling when a viewer that is not the last one closes', async () => {
    let polls = 0
    const closed: number[] = []
    const subscription = new SessionSummaryHostFoldSubscription({
      hostFold: {
        open: async () => snapshot(true),
        peek: async () => {
          polls += 1
          return snapshot(true)
        },
        close: async ({ seenTimelineCount }) => {
          closed.push(seenTimelineCount)
        }
      },
      pollIntervalMs: 1,
      onSnapshot: () => {},
      onError: () => {}
    })
    subscription.open(args)
    subscription.open(args)
    await advance(10)
    subscription.close({
      paneKey: args.paneKey,
      environmentId: args.environmentId,
      seenTimelineCount: 1,
      lastViewer: false
    })
    const afterFirstClose = polls
    await advance(20)

    expect(closed).toEqual([1])
    expect(polls).toBeGreaterThan(afterFirstClose)
    subscription.close({
      paneKey: args.paneKey,
      environmentId: args.environmentId,
      seenTimelineCount: 1,
      lastViewer: true
    })
  })

  // StrictMode mounts, unmounts and mounts again: the leaked close must not eat the second
  // open's lease, and each accepted open still owes exactly one close.
  it('survives an open-close-open sequence', async () => {
    const h = richHarness(async () => snapshot(false))
    h.subscription.open(args)
    h.subscription.close({
      paneKey: args.paneKey,
      environmentId: args.environmentId,
      seenTimelineCount: 0,
      lastViewer: true
    })
    h.subscription.open(args)
    await advance(10)
    h.subscription.close({
      paneKey: args.paneKey,
      environmentId: args.environmentId,
      seenTimelineCount: 2,
      lastViewer: true
    })
    await advance(10)

    expect(h.closed.sort()).toEqual([0, 2])
  })
})

describe('SessionSummaryHostFoldSubscription failed opens', () => {
  // A viewer whose open failed owes the host nothing. If its close spent the next lease in
  // line it would end another viewer's fold on the host — #135's symptom, from the inside.
  it('does not spend another viewer\u2019s lease for an open that failed', async () => {
    let fail = true
    let polls = 0
    const closed: number[] = []
    const subscription = new SessionSummaryHostFoldSubscription({
      hostFold: {
        open: async () => {
          if (fail) {
            fail = false
            throw new Error('relay blip')
          }
          return snapshot(true)
        },
        peek: async () => {
          polls += 1
          return snapshot(true)
        },
        close: async ({ seenTimelineCount }) => {
          closed.push(seenTimelineCount)
        }
      },
      pollIntervalMs: 1,
      onSnapshot: () => {},
      onError: () => {}
    })
    const args = { paneKey: 'tab-1:leaf-1', environmentId: 'env-1', foldParams: null }

    // Window A's open fails; window B's is accepted.
    subscription.open(args)
    await advance(5)
    subscription.open(args)
    await advance(10)
    // A closes: no lease of its own, and B's must survive.
    subscription.close({
      paneKey: args.paneKey,
      environmentId: args.environmentId,
      seenTimelineCount: 1,
      lastViewer: false
    })
    await advance(10)

    expect(closed).toEqual([])
    expect(polls).toBeGreaterThan(0)

    // B closes: now the one real lease is returned.
    subscription.close({
      paneKey: args.paneKey,
      environmentId: args.environmentId,
      seenTimelineCount: 2,
      lastViewer: true
    })
    await advance(5)
    expect(closed).toEqual([2])
  })
})

describe('SessionSummaryHostFoldSubscription absorbed closes', () => {
  type Scripted = { paneKey: string; environmentId: string; foldParams: null }
  const args: Scripted = { paneKey: 'tab-1:leaf-1', environmentId: 'env-1', foldParams: null }

  function scripted(openResults: ('ok' | 'fail')[]) {
    let attempt = 0
    const closed: number[] = []
    const subscription = new SessionSummaryHostFoldSubscription({
      hostFold: {
        open: async () => {
          const outcome = openResults[attempt] ?? 'ok'
          attempt += 1
          if (outcome === 'fail') {
            throw new Error('relay blip')
          }
          return snapshot(false)
        },
        peek: async () => snapshot(false),
        close: async ({ seenTimelineCount }) => {
          closed.push(seenTimelineCount)
        }
      },
      pollIntervalMs: 1,
      onSnapshot: () => {},
      onError: () => {}
    })
    return { subscription, closed }
  }

  const close = (
    subscription: SessionSummaryHostFoldSubscription,
    seenTimelineCount: number,
    lastViewer = false
  ): void =>
    subscription.close({
      paneKey: args.paneKey,
      environmentId: args.environmentId,
      seenTimelineCount,
      lastViewer
    })

  // The open a close was queued on then failed. That open settles its close, and the place it
  // reported rides on the next close this pane sends — the absorbed count is deliberately the
  // higher of the two, so a dropped carry would show up as 7 instead of 12.
  //
  // Two closes follow back to back with a second lease still held, so the place can only be
  // kept from being reported twice by `takeSeen` zeroing it: without that, the second close
  // would repeat the 12. (The idle-pane drop is asserted by the phantom-slot test below.)
  it('carries an absorbed close\u2019s place into the next host close and then resets', async () => {
    const pending: {
      resolve: (value: SessionSummarySnapshot) => void
      reject: (error: Error) => void
    }[] = []
    const closed: number[] = []
    const subscription = new SessionSummaryHostFoldSubscription({
      hostFold: {
        open: () =>
          new Promise<SessionSummarySnapshot>((resolve, reject) => {
            pending.push({ resolve, reject })
          }),
        peek: async () => snapshot(false),
        close: async ({ seenTimelineCount }) => {
          closed.push(seenTimelineCount)
        }
      },
      pollIntervalMs: 1,
      onSnapshot: () => {},
      onError: () => {}
    })
    const close = (seenTimelineCount: number, lastViewer = false): void =>
      subscription.close({
        paneKey: args.paneKey,
        environmentId: args.environmentId,
        seenTimelineCount,
        lastViewer
      })

    subscription.open(args)
    pending[0].resolve(snapshot(false))
    await advance(4)
    close(10)
    await advance(4)
    expect(closed).toEqual([10])

    // A close queued on an open that will fail, while another open stays in flight behind it.
    subscription.open(args)
    close(12)
    subscription.open(args)
    await advance(4)
    pending[1].reject(new Error('relay blip'))
    await advance(4)
    pending[2].resolve(snapshot(false))
    await advance(4)

    // A second lease, so the pane never goes idle between the two closes below.
    subscription.open(args)
    pending[3].resolve(snapshot(false))
    await advance(4)

    // Absorbed 12 beats this close's 7 …
    close(7)
    await advance(4)
    expect(closed).toEqual([10, 12])

    // … and is reported only once: the close of 7 spent it, so this one reports itself.
    close(3, true)
    await advance(4)
    expect(closed).toEqual([10, 12, 3])
  })

  // The other absorption path: the viewer's open fails with nothing queued, and its close
  // arrives after another viewer has taken a lease.
  it('carries the place of a viewer who closes after their open failed', async () => {
    const h = scripted(['ok', 'fail', 'ok'])
    h.subscription.open(args)
    await advance(4)
    close(h.subscription, 1)
    await advance(4)

    h.subscription.open(args)
    await advance(4) // fails: this viewer owes the host nothing

    h.subscription.open(args)
    await advance(4)
    close(h.subscription, 2) // the failed viewer's place, absorbed
    await advance(4)
    close(h.subscription, 1, true) // the lease holder's own count is the lower one
    await advance(4)

    expect(h.closed).toEqual([1, 2])
  })

  // A close queued on an open that then fails must not leave a phantom unleased slot behind:
  // the next real lease's close has to reach the host.
  it('does not leave a phantom slot when a queued close fails', async () => {
    const h = scripted(['ok', 'fail', 'ok'])
    h.subscription.open(args)
    await advance(4)
    close(h.subscription, 1)
    await advance(4)

    // The queued count is deliberately larger than the close below, so a place that outlived
    // the idle pane would be reported as 20 instead of 9.
    h.subscription.open(args)
    close(h.subscription, 20)
    await advance(10)

    h.subscription.open(args)
    await advance(4)
    close(h.subscription, 9, true)
    await advance(4)

    // Exactly one close per accepted open, and none swallowed by a phantom slot.
    expect(h.closed).toEqual([1, 9])
  })
})
