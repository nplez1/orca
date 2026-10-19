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
      foldParams: null,
      lastSnapshot: null
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
      foldParams: null,
      lastSnapshot: null
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
      foldParams: null,
      lastSnapshot: null
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
      foldParams: null,
      lastSnapshot: null
    })
    await wait(10)
    h.subscription.close({ paneKey: 'tab-1:leaf-1', environmentId: 'env-1', seenTimelineCount: 3 })
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
      foldParams: null,
      lastSnapshot: null
    })
    await wait(10)
    // A reopen replaces the chain while the old poll is in flight.
    h.subscription.open({
      paneKey: 'tab-1:leaf-1',
      environmentId: 'env-1',
      foldParams: null,
      lastSnapshot: null
    })
    for (const resolve of resolveLater.splice(0)) {
      resolve()
    }
    await wait(10)

    expect(h.errors).toHaveLength(0)
  })
})
