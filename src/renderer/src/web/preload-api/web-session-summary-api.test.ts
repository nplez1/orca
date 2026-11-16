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
  it('refreshes the pane on the lease it already holds', async () => {
    const api = createWebSessionSummaryApi()
    await api.open({ paneKey: PANE_KEY })
    await api.open({ paneKey: PANE_KEY, sameViewer: true })

    expect(callsTo('sessionSummary.openOnHost')[1]?.[2]).toMatchObject({ sameViewer: true })

    api.close({ paneKey: PANE_KEY, seenTimelineCount: 0 })

    await vi.waitFor(() => expect(callsTo('sessionSummary.closeOnHost')).toHaveLength(1))
  })

  // Why: a pane opened before the client was paired holds no lease, so its first refresh has to
  // take one — and must not claim to be a refresh, which would tell the host to skip its own.
  it('takes the lease a refresh of an unpaired open was never given', async () => {
    mocks.environment.mockReturnValue(null)
    const api = createWebSessionSummaryApi()
    await api.open({ paneKey: PANE_KEY })

    mocks.environment.mockReturnValue({ id: 'env-1' })
    await api.open({ paneKey: PANE_KEY, sameViewer: true })

    // The fold client sends `sameViewer: sameViewer ?? null`, so null is exactly "not claimed".
    expect(callsTo('sessionSummary.openOnHost')[0]?.[2]).toMatchObject({ sameViewer: null })

    api.close({ paneKey: PANE_KEY, seenTimelineCount: 0 })

    await vi.waitFor(() => expect(callsTo('sessionSummary.closeOnHost')).toHaveLength(1))
  })

  // Why: a re-pair mid-lease must not move this pane's fold to the new host — the lease it is
  // reading through lives on the old one, and only a close there ends it. The rows this client
  // reads are re-stamped with the new pairing, so that id must not travel either.
  it('keeps folding on the host that holds the lease, and never names the new pairing', async () => {
    const api = createWebSessionSummaryApi()
    await api.open({ paneKey: PANE_KEY })
    mocks.environment.mockReturnValue({ id: 'env-2' })

    await api.open({ paneKey: PANE_KEY, sameViewer: true, executionHostId: 'runtime:env-2' })

    expect(callsTo('sessionSummary.openOnHost')[1]?.[0]).toBe('env-1')
    expect(callsTo('sessionSummary.openOnHost')[1]?.[2]).not.toHaveProperty('executionHostId')
  })

  it('reports a refresh as folding until the host answers', async () => {
    const api = createWebSessionSummaryApi()
    const seen: SessionSummarySnapshot[] = []
    api.onUpdate((next) => seen.push(next))
    await api.open({ paneKey: PANE_KEY })
    // Why: a snapshot has to be on screen, or the refresh answers a synthetic one that is
    // folding anyway and the assertion would hold however the shown brief is reported.
    await vi.waitFor(() => expect(seen).toHaveLength(1))

    const answered = await api.open({ paneKey: PANE_KEY, sameViewer: true })

    expect(answered.fold.running).toBe(true)
  })

  // Why: an answer that lands after the last close belongs to a pane nobody is reading, and
  // keeping it would brief the next session in that pane with the previous one's summary.
  it('stops delivering once the last viewer has closed the pane', async () => {
    // Why per method: a close resolves at once, so one shared resolver would answer the close
    // instead of the fold and the pane's open would never settle.
    const answers: ((value: unknown) => void)[] = []
    mocks.call.mockImplementation((_environmentId: unknown, method: unknown) =>
      method === 'sessionSummary.closeOnHost'
        ? Promise.resolve(ok(null))
        : new Promise((resolve) => {
            answers.push((value: unknown) => resolve(ok(value)))
          })
    )
    const api = createWebSessionSummaryApi()
    const seen: SessionSummarySnapshot[] = []
    api.onUpdate((next) => seen.push(next))
    await api.open({ paneKey: PANE_KEY })

    // The same answer delivered while the pane is read, so the negative case below is not vacuous.
    answers.shift()?.(snapshot())
    await vi.waitFor(() => expect(seen).toHaveLength(1))

    await api.open({ paneKey: PANE_KEY, sameViewer: true })
    api.close({ paneKey: PANE_KEY, seenTimelineCount: 0 })
    answers.shift()?.(snapshot())
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(seen).toHaveLength(1)
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
