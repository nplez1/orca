import { describe, expect, it } from 'vitest'
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

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

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
    await wait(20)
    const seen = h.snapshots.length
    await wait(20)

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
    await wait(30)

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
    await wait(40)

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
    await wait(10)
    h.subscription.close({
      paneKey: 'tab-1:leaf-1',
      environmentId: 'env-1',
      seenTimelineCount: 3,
      lastViewer: true
    })
    const seen = calls
    await wait(20)

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
    await wait(10)
    // A reopen replaces the chain while the old poll is in flight.
    h.subscription.open({
      paneKey: 'tab-1:leaf-1',
      environmentId: 'env-1',
      foldParams: null
    })
    for (const resolve of resolveLater.splice(0)) {
      resolve()
    }
    await wait(10)

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
    await wait(10)

    expect(h.closed).toEqual([4])
    // The viewer is gone, so the answer must not restart polling.
    await wait(10)
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
    await wait(10)

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
    await wait(10)
    subscription.close({
      paneKey: args.paneKey,
      environmentId: args.environmentId,
      seenTimelineCount: 1,
      lastViewer: false
    })
    const afterFirstClose = polls
    await wait(20)

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
    await wait(10)
    h.subscription.close({
      paneKey: args.paneKey,
      environmentId: args.environmentId,
      seenTimelineCount: 2,
      lastViewer: true
    })
    await wait(10)

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
    await wait(5)
    subscription.open(args)
    await wait(10)
    // A closes: no lease of its own, and B's must survive.
    subscription.close({
      paneKey: args.paneKey,
      environmentId: args.environmentId,
      seenTimelineCount: 1,
      lastViewer: false
    })
    await wait(10)

    expect(closed).toEqual([])
    expect(polls).toBeGreaterThan(0)

    // B closes: now the one real lease is returned.
    subscription.close({
      paneKey: args.paneKey,
      environmentId: args.environmentId,
      seenTimelineCount: 2,
      lastViewer: true
    })
    await wait(5)
    expect(closed).toEqual([2])
  })
})

describe('SessionSummaryHostFoldSubscription absorbed closes', () => {
  // The open a close was queued on then failed: that open settles the close, and the viewer's
  // place on the timeline must still reach the host with the next close — without inventing
  // an unleased slot that would swallow the next real lease.
  it('carries an absorbed close\u2019s place to the next host close', async () => {
    let attempt = 0
    const closed: number[] = []
    const subscription = new SessionSummaryHostFoldSubscription({
      hostFold: {
        open: async () => {
          attempt += 1
          if (attempt === 1) {
            return snapshot(false)
          }
          if (attempt === 2) {
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
    const args = { paneKey: 'tab-1:leaf-1', environmentId: 'env-1', foldParams: null }

    // First viewer gets a lease and uses it.
    subscription.open(args)
    await wait(5)
    subscription.close({
      paneKey: args.paneKey,
      environmentId: args.environmentId,
      seenTimelineCount: 10,
      lastViewer: false
    })
    await wait(5)
    expect(closed).toEqual([10])

    // Second viewer closes before its own open fails.
    subscription.open(args)
    subscription.close({
      paneKey: args.paneKey,
      environmentId: args.environmentId,
      seenTimelineCount: 4,
      lastViewer: false
    })
    await wait(5)

    // Third viewer opens (accepted) and closes: the absorbed place rides along, furthest wins.
    subscription.open(args)
    await wait(5)
    subscription.close({
      paneKey: args.paneKey,
      environmentId: args.environmentId,
      seenTimelineCount: 7,
      lastViewer: true
    })
    await wait(5)

    expect(closed).toEqual([10, 7])
  })

  // A close queued on an open that then fails must not leave a phantom unleased slot behind:
  // the next real lease's close has to reach the host.
  it('does not leave a phantom slot when a queued close fails', async () => {
    let attempt = 0
    const closed: number[] = []
    const subscription = new SessionSummaryHostFoldSubscription({
      hostFold: {
        open: async () => {
          attempt += 1
          if (attempt === 2) {
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
    const args = { paneKey: 'tab-1:leaf-1', environmentId: 'env-1', foldParams: null }

    // A first viewer whose lease is already returned, so the next close has nothing to spend.
    subscription.open(args)
    await wait(5)
    subscription.close({
      paneKey: args.paneKey,
      environmentId: args.environmentId,
      seenTimelineCount: 1,
      lastViewer: false
    })
    await wait(5)

    // A close that queues on the open which is about to fail.
    subscription.open(args)
    subscription.close({
      paneKey: args.paneKey,
      environmentId: args.environmentId,
      seenTimelineCount: 2,
      lastViewer: false
    })
    await wait(10)

    subscription.open(args)
    await wait(5)
    subscription.close({
      paneKey: args.paneKey,
      environmentId: args.environmentId,
      seenTimelineCount: 9,
      lastViewer: true
    })
    await wait(5)

    // Exactly one close per accepted open, and none swallowed by a phantom slot.
    expect(closed).toEqual([1, 9])
  })
})
