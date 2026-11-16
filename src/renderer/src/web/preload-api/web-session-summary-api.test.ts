import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummarySnapshot } from '../../../../shared/session-summary-types'
import type { RuntimeRpcResponse } from '../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  settings: vi.fn(),
  environment: vi.fn()
}))

vi.mock('./web-runtime-calls', () => ({
  callEnvironmentEnvelope: (...args: unknown[]) => mocks.call(...args)
}))
vi.mock('./web-preferences-store', () => ({
  getStoredSettings: () => mocks.settings()
}))
vi.mock('./web-runtime-session', () => ({
  requireActiveEnvironmentOrNull: () => mocks.environment()
}))

const { createWebSessionSummaryApi, WEB_SESSION_SUMMARY_NO_HOST_MESSAGE } =
  await import('./web-session-summary-api')

function snapshot(overrides: Partial<SessionSummarySnapshot> = {}): SessionSummarySnapshot {
  return {
    paneKey: PANE_KEY,
    status: 'ready',
    facts: null,
    ledger: null,
    seenThrough: 0,
    fold: { running: false, completedChunks: 0, totalChunks: 0 },
    ...overrides
  }
}

function ok(result: unknown): RuntimeRpcResponse<unknown> {
  return { id: 'reply', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

function callsTo(method: string): unknown[][] {
  return mocks.call.mock.calls.filter((call) => call[1] === method)
}

beforeEach(() => {
  mocks.call.mockReset()
  mocks.call.mockResolvedValue(ok(snapshot()))
  mocks.settings.mockReset()
  mocks.settings.mockReturnValue({ defaultTuiAgent: 'claude' })
  mocks.environment.mockReset()
  mocks.environment.mockReturnValue({ id: 'env-1' })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('web session summary api', () => {
  it('asks the paired host to fold the pane and answers with a snapshot for it', async () => {
    const api = createWebSessionSummaryApi()

    const answered = await api.open({
      paneKey: PANE_KEY,
      executionHostId: 'runtime:env-2'
    })

    expect(callsTo('sessionSummary.openOnHost')).toEqual([
      [
        'env-1',
        'sessionSummary.openOnHost',
        // A workspace owned by another host travels: this client can read one the host it is
        // paired with holds no status row for.
        expect.objectContaining({ paneKey: PANE_KEY, executionHostId: 'runtime:env-2' })
      ]
    ])
    expect(answered.paneKey).toBe(PANE_KEY)
  })

  // Why: a browser client stamps every row its server sends with `runtime:<its pairing id>`, so
  // the common case names the paired server itself. Sent on, the server would look for an
  // environment of its own by that name and fold nowhere.
  it('does not name the pairing itself as a workspace host', async () => {
    const api = createWebSessionSummaryApi()

    await api.open({ paneKey: PANE_KEY, executionHostId: 'runtime:env-1' })

    expect(callsTo('sessionSummary.openOnHost')[0]?.[2]).not.toHaveProperty('executionHostId')
  })

  // Why: the fold spawns an agent, and a host substituting its own Settings → Agents choice
  // would run one the reader never picked in this client.
  it('folds with the agent this client is configured to summarize with', async () => {
    const api = createWebSessionSummaryApi()

    await api.open({ paneKey: PANE_KEY })

    expect(callsTo('sessionSummary.openOnHost')[0]?.[2]).toMatchObject({
      foldParams: { agentId: 'claude', model: 'sonnet' }
    })
  })

  it('delivers the host snapshots to update listeners', async () => {
    const api = createWebSessionSummaryApi()
    const seen: SessionSummarySnapshot[] = []
    api.onUpdate((next) => seen.push(next))

    await api.open({ paneKey: PANE_KEY })

    await vi.waitFor(() => expect(seen.map((next) => next.paneKey)).toContain(PANE_KEY))
  })

  // Why: a re-pair mid-fold must not send this pane's close to a host that never took its
  // lease — that would release whatever that host's own window holds for the same pane.
  it('closes the pane on the host that accepted the open', async () => {
    const api = createWebSessionSummaryApi()
    await api.open({ paneKey: PANE_KEY })
    mocks.environment.mockReturnValue({ id: 'env-2' })

    api.close({ paneKey: PANE_KEY, seenTimelineCount: 0 })

    // The close waits for the open it is owed to, so it lands a tick after the pane closes.
    await vi.waitFor(() =>
      expect(callsTo('sessionSummary.closeOnHost')).toEqual([
        ['env-1', 'sessionSummary.closeOnHost', { paneKey: PANE_KEY, seenTimelineCount: 0 }]
      ])
    )
  })

  // Why: a refresh is the same reader asking again, so a second lease here would outlive the
  // one close an unmount sends and the host's fold would never stop.
  it('does not take a second lease for a refresh', async () => {
    const api = createWebSessionSummaryApi()
    await api.open({ paneKey: PANE_KEY })
    await api.open({ paneKey: PANE_KEY, sameViewer: true })

    api.close({ paneKey: PANE_KEY, seenTimelineCount: 0 })

    await vi.waitFor(() => expect(callsTo('sessionSummary.closeOnHost')).toHaveLength(1))
  })

  // Why: a poll that lands after the last close belongs to a pane nobody is reading, and keeping
  // it would brief the next session in that pane with the previous one's summary.
  it('stops delivering once the last viewer has closed the pane', async () => {
    let answer: (value: unknown) => void = () => {}
    mocks.call.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = (value: unknown) => resolve(ok(value))
        })
    )
    const api = createWebSessionSummaryApi()
    const seen: SessionSummarySnapshot[] = []
    api.onUpdate((next) => seen.push(next))
    await api.open({ paneKey: PANE_KEY })
    api.close({ paneKey: PANE_KEY, seenTimelineCount: 0 })

    answer(snapshot())

    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalled())
    expect(seen).toEqual([])
  })

  it('reports an unpaired client instead of asking a host that is not there', async () => {
    mocks.environment.mockReturnValue(null)
    const api = createWebSessionSummaryApi()

    const answered = await api.open({ paneKey: PANE_KEY })

    expect(answered).toMatchObject({
      paneKey: PANE_KEY,
      status: 'failed',
      error: WEB_SESSION_SUMMARY_NO_HOST_MESSAGE
    })
    expect(mocks.call).not.toHaveBeenCalled()
  })

  it('names an out-of-date host rather than reporting a fold that failed', async () => {
    mocks.call.mockResolvedValue({
      id: 'reply',
      ok: false,
      error: { code: 'method_not_found', message: 'no such method' }
    })
    const api = createWebSessionSummaryApi()
    const seen: SessionSummarySnapshot[] = []
    api.onUpdate((next) => seen.push(next))

    await api.open({ paneKey: PANE_KEY })

    await vi.waitFor(() =>
      expect(seen.at(-1)).toMatchObject({ status: 'failed', error: 'host-outdated' })
    )
  })
})
