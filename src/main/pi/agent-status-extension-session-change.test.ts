import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createAgentStatusExtensionHarness,
  type AgentStatusExtensionHarness,
  type HookContext
} from './agent-status-extension-test-harness'
import {
  agentEndCount,
  childIds,
  complete,
  endTurn,
  exitRunner,
  idle,
  postedHookNames,
  postedSubagentRunIds,
  posts,
  startAsync,
  startChild,
  startWorkflow,
  WORKFLOW
} from './agent-status-subagent-event-fixtures'

// Orderings mirror runs recorded from Pi 0.87.1 with pi-subagents 0.71.0: a session change or
// /reload shuts the old registration down and runs the factory again on a fresh `pi.events`.
function session(id: string) {
  return {
    isIdle: () => true,
    sessionManager: { getSessionId: () => id, getSessionFile: () => `/sessions/${id}.jsonl` }
  }
}

function createPi(fetchImpl?: () => Promise<unknown>): AgentStatusExtensionHarness {
  return createAgentStatusExtensionHarness({ kind: 'pi', existsSync: () => true, fetchImpl })
}

async function holdRunOpen(harness: AgentStatusExtensionHarness, sessionId = 'A'): Promise<void> {
  await harness.callHook('session_start', { reason: 'startup' }, session(sessionId))
  await harness.callHook('agent_start', {}, session(sessionId))
  startAsync(harness, 'run-a', 'scout')
  await endTurn(harness)
}

describe('Pi session changes', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([
    ['new', undefined],
    ['resume', '/sessions/B.jsonl'],
    ['fork', '/sessions/B.jsonl']
  ] as const)(
    'ends the run its children held open under the old session on %s, before the next one starts',
    async (reason, target) => {
      const harness = createPi()
      await holdRunOpen(harness)
      // Why: LOCAL(nplez1) — the fork reports pi children as a live `subagent_runs` set and the pane
      // is held receiver-side from it, so the lead's own `agent_end` is never withheld here.
      expect(agentEndCount(harness)).toBe(1)

      await harness.replacePiSession(reason, target)
      await harness.callHook('session_start', { reason }, session('B'))
      await vi.advanceTimersByTimeAsync(0)

      const [completion, nextSession] = posts(harness).slice(-2)
      // Why: that completion already ended the run, so the session change has nothing left to close
      // out and adds no `session_boundary` completion of its own.
      expect(completion).toMatchObject({
        hook_event_name: 'agent_end',
        session_id: 'A',
        session_file: '/sessions/A.jsonl'
      })
      expect(completion).not.toHaveProperty('session_boundary')
      // Why: the closed-out session's live set is dropped, so its children never ride the next
      // session's post — the receiver replaces its child list with every post it receives.
      expect(nextSession).toMatchObject({
        hook_event_name: 'session_start',
        session_id: 'B',
        session_file: '/sessions/B.jsonl',
        subagent_runs: []
      })
    }
  )

  it('ends the run for a Pi too old to say why it shut the session down', async () => {
    const harness = createPi()
    await holdRunOpen(harness)
    await harness.callHook('session_shutdown')
    await vi.advanceTimersByTimeAsync(0)

    expect(posts(harness).at(-1)).toMatchObject({ hook_event_name: 'agent_end', session_id: 'A' })
  })

  it('posts nothing on quit, even with children still running', async () => {
    const harness = createPi()
    await holdRunOpen(harness)
    const sent = posts(harness).length
    await harness.callHook('session_shutdown', { reason: 'quit' })
    await vi.advanceTimersByTimeAsync(5_000)

    expect(posts(harness)).toHaveLength(sent)
  })

  it('re-opens the run for a child of the next session after a turn the old one cut off', async () => {
    const harness = createPi()
    await harness.callHook('session_start', { reason: 'startup' }, session('A'))
    await harness.callHook('agent_start', {}, session('A'))
    await harness.replacePiSession('new')
    await harness.callHook('session_start', { reason: 'new' }, session('B'))
    startAsync(harness, 'run-b', 'scout')
    complete(harness, 'run-b')
    await vi.advanceTimersByTimeAsync(0)

    // Why: LOCAL(nplez1) — a child of the next session is reported by the live `subagent_runs` set
    // shrinking, under that session; the fork opens no run for it, so no `agent_start`/`agent_end`
    // pair follows and the post carries no session boundary.
    const completion = posts(harness).at(-1)
    expect(completion).toMatchObject({ hook_event_name: 'subagent_async_state', session_id: 'B' })
    expect(completion).not.toHaveProperty('session_boundary')
    expect(completion?.subagent_runs).toEqual([])
  })

  it('keeps a completion that was still waiting to be sent when the session changed', async () => {
    const releases: (() => void)[] = []
    const harness = createPi(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve({ ok: true }))
        })
    )
    await harness.callHook('session_start', { reason: 'startup' }, session('A'))
    await harness.callHook('agent_start', {}, session('A'))
    // Pi aborts the turn before it shuts the session down; that completion queues behind the post in flight.
    await endTurn(harness)
    await harness.replacePiSession('new')
    await harness.callHook('session_start', { reason: 'new' }, session('B'))

    while (releases.length > 0) {
      releases.shift()?.()
      await vi.advanceTimersByTimeAsync(0)
    }
    expect(posts(harness).slice(-2)).toMatchObject([
      { hook_event_name: 'agent_end', session_id: 'A' },
      { hook_event_name: 'session_start', session_id: 'B' }
    ])
    // A turn that really finished is a completion, not a session boundary.
    expect(posts(harness).at(-2)).not.toHaveProperty('session_boundary')
  })

  it('gives up on a completion Orca keeps refusing, then sends what came after', async () => {
    let attempts = 0
    const harness = createPi(async () => {
      attempts += 1
      if (attempts >= 3 && attempts <= 6) {
        throw new Error('Orca down')
      }
      return { ok: true }
    })
    await holdRunOpen(harness)
    await harness.replacePiSession('new')
    await harness.callHook('session_start', { reason: 'new' }, session('B'))
    await vi.advanceTimersByTimeAsync(5_000)

    expect(agentEndCount(harness)).toBe(5)
    expect(posts(harness).at(-1)).toMatchObject({
      hook_event_name: 'session_start',
      session_id: 'B'
    })
  })

  it('posts nothing for an old session whose run already ended', async () => {
    const harness = createPi()
    await harness.callHook('agent_start', {}, session('A'))
    await endTurn(harness)
    expect(agentEndCount(harness)).toBe(1)

    await harness.replacePiSession('fork', '/sessions/B.jsonl')
    await vi.advanceTimersByTimeAsync(0)

    expect(agentEndCount(harness)).toBe(1)
  })

  it('delivers the old session’s completion ahead of a new session posted behind an in-flight delivery', async () => {
    const releases: (() => void)[] = []
    const harness = createPi(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve({ ok: true }))
        })
    )
    await holdRunOpen(harness)
    await harness.replacePiSession('new')
    await harness.callHook('session_start', { reason: 'new' }, session('B'))
    // A child of the new session must not ride on the old session's last post.
    startAsync(harness, 'run-b', 'scout')

    while (releases.length > 0) {
      releases.shift()?.()
      await vi.advanceTimersByTimeAsync(0)
    }
    const completion = posts(harness).find((post) => post.hook_event_name === 'agent_end')
    expect(completion).toMatchObject({ session_id: 'A' })
    expect(completion?.subagents).toBeUndefined()
    // Why: LOCAL(nplez1) — the new session's post is the live `subagent_runs` set update rather
    // than upstream's `agent_start` roster row; the old session's completion still precedes it.
    expect(postedHookNames(harness).slice(-2)).toEqual(['agent_end', 'subagent_async_state'])
    expect(posts(harness).at(-1)).toMatchObject({ session_id: 'B' })
    expect(postedSubagentRunIds(harness).at(-1)).toEqual(['run-b'])
  })

  it('retries the old session’s completion before sending anything newer', async () => {
    let attempts = 0
    const harness = createPi(async () => {
      attempts += 1
      // The close-out follows session_start and agent_start; fail its first delivery.
      if (attempts === 3) {
        throw new Error('Orca restarting')
      }
      return { ok: true }
    })
    await holdRunOpen(harness)
    await harness.replacePiSession('new')
    await harness.callHook('session_start', { reason: 'new' }, session('B'))
    await vi.advanceTimersByTimeAsync(0)
    // Why: LOCAL(nplez1) — the lead's own `agent_end` is posted rather than withheld for a child, so
    // the delivery that fails here is that completion; pi's non-final posts are dropped on failure
    // instead of being re-queued ahead of the newer session_start.
    expect(postedHookNames(harness).at(-1)).toBe('session_start')
    expect(agentEndCount(harness)).toBe(2)
    await vi.advanceTimersByTimeAsync(250)

    expect(posts(harness).slice(-3)).toMatchObject([
      { hook_event_name: 'agent_end', session_id: 'A' },
      { hook_event_name: 'agent_end', session_id: 'A' },
      { hook_event_name: 'session_start', session_id: 'B' }
    ])
  })

  it('refuses a child a closed-out session reports after close-out', async () => {
    const harness = createPi()
    await holdRunOpen(harness)
    await harness.callHook('session_shutdown', { reason: 'new' })
    await vi.advanceTimersByTimeAsync(0)
    const sent = posts(harness).length

    // Another extension's shutdown handler can still be running while pi-subagents emits here.
    startAsync(harness, 'run-late', 'scout')
    await vi.advanceTimersByTimeAsync(0)
    // Why: LOCAL(nplez1) — Pi replaces the registration while the bus subscription it bound can
    // still be called, so close-out invalidates that registration. A child it names belongs to the
    // session the pane has stopped showing, and must not join the set the next session posts.
    expect(posts(harness)).toHaveLength(sent)

    await harness.replacePiSession('new')
    await harness.callHook('session_start', { reason: 'new' }, session('B'))
    await harness.callHook('agent_start', {}, session('B'))
    await endTurn(harness)
    expect(postedSubagentRunIds(harness).at(-1)).toEqual([])
    expect(
      posts(harness)
        .slice(sent)
        .some((post) => post.subagents)
    ).toBe(false)
  })

  it('leaves no timer of the old session running', async () => {
    const harness = createPi()
    await holdRunOpen(harness)
    exitRunner(harness, 'run-a')
    await vi.advanceTimersByTimeAsync(0)
    // Why: LOCAL(nplez1) — the runner-exit grace timer belongs to upstream's roster lane, which the
    // fork leaves unbound on pi: its own lane retires a child on the exit itself, so no timer is
    // armed to leak into the next session.
    expect(vi.getTimerCount()).toBe(0)

    await harness.replacePiSession('new')
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not bring back a child whose runner had already exited', async () => {
    const harness = createPi()
    await holdRunOpen(harness)
    exitRunner(harness, 'run-a')
    await harness.replacePiSession('new')
    await harness.callHook('session_start', { reason: 'new' }, session('B'))
    await harness.replacePiSession('resume', '/sessions/A.jsonl')
    await harness.callHook('session_start', { reason: 'resume' }, session('A'))
    await vi.advanceTimersByTimeAsync(0)

    expect(posts(harness).at(-1)).toMatchObject({
      hook_event_name: 'session_start',
      session_id: 'A'
    })
  })

  it('brings a session’s children back when it is resumed, and shows none of them under another session', async () => {
    const harness = createPi()
    await holdRunOpen(harness)
    await harness.replacePiSession('new')
    await harness.callHook('session_start', { reason: 'new' }, session('B'))
    await vi.advanceTimersByTimeAsync(0)
    // pi-subagents keeps a session change's children running, and the pane rides one live set, so the
    // session now on screen must carry none of the closed one's.
    expect(postedSubagentRunIds(harness).at(-1)).toEqual([])
    startAsync(harness, 'run-b', 'reviewer')
    complete(harness, 'run-b')
    await vi.advanceTimersByTimeAsync(0)
    expect(postedSubagentRunIds(harness).at(-1)).toEqual([])
    expect(
      posts(harness)
        .filter((post) => post.session_id === 'B')
        .every((post) => (post.subagent_runs ?? []).every((run) => run.id !== 'run-a'))
    ).toBe(true)

    await harness.replacePiSession('resume', '/sessions/A.jsonl')
    await harness.callHook('session_start', { reason: 'resume' }, session('A'))
    await vi.advanceTimersByTimeAsync(0)
    // Why: LOCAL(nplez1) — the session that comes back is the one its children were never taken
    // from, so the resume itself carries them, with the detail the bus reported when they started.
    expect(posts(harness).at(-1)).toMatchObject({
      hook_event_name: 'session_start',
      session_id: 'A',
      session_file: '/sessions/A.jsonl'
    })
    expect(posts(harness).at(-1)?.subagent_runs).toEqual([
      expect.objectContaining({ id: 'run-a', description: expect.any(String) })
    ])

    // pi-subagents reports the run's completion to the resumed session, finished or not.
    complete(harness, 'run-a')
    await vi.advanceTimersByTimeAsync(0)
    expect(posts(harness).at(-1)).toMatchObject({
      hook_event_name: 'subagent_async_state',
      session_id: 'A'
    })
    expect(postedSubagentRunIds(harness).at(-1)).toEqual([])
    // Why: LOCAL(nplez1) — a restored child leaves the live set, which is what settles the pane
    // receiver-side; this lane never fabricates a completion of its own for one.
    expect(agentEndCount(harness)).toBe(1)
  })

  it('posts nothing more once a session ends with a child still live, however often it is shut down', async () => {
    const harness = createPi()
    await harness.callHook('session_start', { reason: 'startup' }, session('A'))
    await harness.callHook('agent_start', {}, session('A'))
    startAsync(harness, 'run-a', 'scout')
    // Two shutdown handlers race on a session whose run its children still hold open.
    await harness.callHook('session_shutdown', { reason: 'new' })
    await harness.callHook('session_shutdown', { reason: 'new' })
    await vi.advanceTimersByTimeAsync(5_000)

    // Why: the run is closed out once, under the session that ran it — a second close-out finds no
    // turn left to end, and a child that is merely still running is not a completion.
    expect(agentEndCount(harness)).toBe(1)
    expect(posts(harness).at(-1)).toMatchObject({
      hook_event_name: 'agent_end',
      session_id: 'A',
      session_boundary: true
    })
  })

  it('restores a session’s children once, not on every later resume', async () => {
    const harness = createPi()
    await holdRunOpen(harness)
    await harness.replacePiSession('new')
    await harness.callHook('session_start', { reason: 'new' }, session('B'))
    await harness.replacePiSession('resume', '/sessions/A.jsonl')
    await harness.callHook('session_start', { reason: 'resume' }, session('A'))
    complete(harness, 'run-a')
    await vi.advanceTimersByTimeAsync(0)
    await harness.replacePiSession('new')
    await harness.callHook('session_start', { reason: 'new' }, session('B'))
    await harness.replacePiSession('resume', '/sessions/A.jsonl')
    await harness.callHook('session_start', { reason: 'resume' }, session('A'))
    await vi.advanceTimersByTimeAsync(0)

    expect(posts(harness).at(-1)).toMatchObject({
      hook_event_name: 'session_start',
      session_id: 'A'
    })
    expect(postedSubagentRunIds(harness).at(-1)).toEqual([])
    expect(posts(harness).at(-1)?.subagents).toBeUndefined()
  })

  it('keeps the children across a resume into the same session file', async () => {
    const harness = createPi()
    await holdRunOpen(harness)
    await harness.replacePiSession('resume', '/sessions/A.jsonl')
    await harness.callHook('session_start', { reason: 'resume' }, session('A'))
    await vi.advanceTimersByTimeAsync(0)
    // Why: LOCAL(nplez1) — the lead's own `agent_end` is never withheld, so a resume cannot add a
    // second one; what a kept session keeps is its children, carried on the resume's own post.
    expect(agentEndCount(harness)).toBe(1)
    expect(postedSubagentRunIds(harness).at(-1)).toEqual(['run-a'])

    complete(harness, 'run-a')
    await vi.advanceTimersByTimeAsync(0)
    // Why: the child leaves the live set, which is what settles the pane receiver-side; the
    // extension posts no completion of its own for it.
    expect(postedSubagentRunIds(harness).at(-1)).toEqual([])
    expect(agentEndCount(harness)).toBe(1)
  })
})

describe('Pi /reload', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps the children and the hold across a reload', async () => {
    const harness = createPi()
    await holdRunOpen(harness)
    await harness.reloadPi()
    await harness.callHook('session_start', { reason: 'reload' }, session('A'))
    expect(harness.piEventListenerCount('subagent:async-complete')).toBe(1)
    // Why: LOCAL(nplez1) — the fork's own bus also binds the runner-exit channel for pi
    // (patch: local(pi-descendants)), so a re-registered factory leaves two listeners on it.
    expect(harness.piEventListenerCount('subagent:process-terminal')).toBe(2)

    // A turn that ends while the pre-reload child still runs must not report done.
    await harness.callHook('agent_start', {}, session('A'))
    await vi.advanceTimersByTimeAsync(0)
    // Why: LOCAL(nplez1) — the live set is keyed by the session that owns it on a home a
    // re-evaluated module cannot rebuild (globalThis), so the pre-reload child is still this
    // session's; the ledger's promise for a /reload is exactly this set surviving.
    expect(postedSubagentRunIds(harness).at(-1)).toEqual(['run-a'])
    await endTurn(harness)
    // Why: nothing is withheld at source, so the turn reports its own completion; the pane's hold
    // comes from the live set the receiver keeps.
    expect(agentEndCount(harness)).toBe(2)

    complete(harness, 'run-a')
    await vi.advanceTimersByTimeAsync(0)
    expect(postedSubagentRunIds(harness).at(-1)).toEqual([])
    expect(agentEndCount(harness)).toBe(2)
  })

  it('files a child that reports in the reload window under the session that owns it', async () => {
    const harness = createPi()
    await holdRunOpen(harness)
    // The module is evaluated again, so its `sessionMetadata` is empty until the resumed session's own
    // `session_start`; a background child can report in between.
    await harness.reloadPi()
    startAsync(harness, 'run-b', 'scout')
    await vi.advanceTimersByTimeAsync(0)
    await harness.callHook('session_start', { reason: 'reload' }, session('A'))
    await harness.callHook('agent_start', {}, session('A'))
    await vi.advanceTimersByTimeAsync(0)

    // Why: LOCAL(nplez1) — a reload keeps the session, so the child is filed under it and reported
    // with the pre-reload one rather than under an unnamed session the pane would never read again.
    expect(postedSubagentRunIds(harness).at(-1)).toEqual(['run-a', 'run-b'])
  })

  it('keeps the turn counters across a reload, so a child starting afterwards is not read as late', async () => {
    const harness = createPi()
    await harness.callHook('agent_start', {}, session('A'))
    await harness.reloadPi()
    startAsync(harness, 'run-a', 'scout')
    complete(harness, 'run-a')
    await vi.advanceTimersByTimeAsync(0)
    expect(agentEndCount(harness)).toBe(0)

    await endTurn(harness)
    expect(agentEndCount(harness)).toBe(1)
  })

  it('releases a workflow’s pre-reload children when the workflow ends', async () => {
    const harness = createPi()
    await harness.callHook('agent_start', {}, session('A'))
    startWorkflow(harness)
    startChild(harness, 'child-a')
    await endTurn(harness)
    // Pi drops the old registration's runner-exit events, so child-a never reports its end.
    await harness.reloadPi()
    complete(harness, WORKFLOW)
    await vi.advanceTimersByTimeAsync(0)

    expect(agentEndCount(harness)).toBe(1)
    expect(posts(harness).at(-1)?.subagents).toBeUndefined()
  })

  it('parts with a workflow a reload released, keeping the child that reported no end of its own', async () => {
    const harness = createPi()
    await harness.callHook('agent_start', {}, session('A'))
    startWorkflow(harness)
    startChild(harness, 'child-a')
    await harness.reloadPi()
    complete(harness, WORKFLOW)
    await vi.advanceTimersByTimeAsync(0)

    // Why: LOCAL(nplez1) — the live set now survives the reload, so the released workflow leaves it
    // and its child does not: this lane retires a child on its own end signal and keeps no parent
    // link to sweep it with the workflow, so the child's exit is what retires it.
    expect(posts(harness)).toEqual([
      { hook_event_name: 'agent_start', subagent_runs: [] },
      { hook_event_name: 'subagent_async_state', subagent_runs: [{ id: 'child-a' }] }
    ])

    exitRunner(harness, 'child-a')
    await vi.advanceTimersByTimeAsync(0)
    expect(postedSubagentRunIds(harness).at(-1)).toEqual([])
  })

  it.each(['reload', 'resume'] as const)(
    'settles an exited runner after same-session %s without another turn',
    async (reason) => {
      const harness = createPi()
      await harness.callHook('session_start', {}, session('A'))
      await harness.callHook('agent_start', {}, session('A'))
      startChild(harness, 'child-a', 'tool-call-1')
      await endTurn(harness)
      exitRunner(harness, 'child-a')
      await vi.advanceTimersByTimeAsync(1_000)
      await (reason === 'reload'
        ? harness.reloadPi()
        : harness.replacePiSession('resume', '/sessions/A.jsonl'))
      await harness.callHook('session_start', { reason }, session('A'))
      await vi.advanceTimersByTimeAsync(999)
      // Why: LOCAL(nplez1) — the lead's own `agent_end` was posted when the turn ended, so no grace
      // timer is pending for it and the reload/resume adds no completion of its own.
      expect(agentEndCount(harness)).toBe(1)
      await vi.advanceTimersByTimeAsync(1)

      expect(agentEndCount(harness)).toBe(1)
      // Why: the exited runner's child never re-enters the live set the fork posts.
      expect(postedSubagentRunIds(harness).at(-1)).toEqual([])
      expect(posts(harness).at(-1)?.subagents).toBeUndefined()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it.each(['new', 'quit'] as const)(
    'clears runner grace when the session ends on %s',
    async (reason) => {
      const harness = createPi()
      await holdRunOpen(harness)
      exitRunner(harness, 'run-a')
      await vi.advanceTimersByTimeAsync(0)
      // Why: LOCAL(nplez1) — the runner-exit grace timer belongs to upstream's roster lane, which the
      // fork leaves unbound on pi; the fork's own lane retires the child on the exit itself.
      expect(vi.getTimerCount()).toBe(0)
      await harness.callHook('session_shutdown', { reason })
      await vi.advanceTimersByTimeAsync(0)
      const completionCount = agentEndCount(harness)
      await vi.advanceTimersByTimeAsync(5_000)

      expect(agentEndCount(harness)).toBe(completionCount)
      expect(vi.getTimerCount()).toBe(0)
    }
  )
})

describe('children that start outside a turn', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('re-opens a finished OMP run for a late child and ends it when the child does', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    await harness.callHook('agent_start')
    await harness.callHook('agent_end', {})
    await vi.advanceTimersByTimeAsync(0)
    harness.emitPiEvent('task:subagent:lifecycle', { id: 'w1', agent: 'task', status: 'started' })
    await vi.advanceTimersByTimeAsync(0)
    harness.emitPiEvent('task:subagent:lifecycle', { id: 'w1', status: 'completed' })
    await vi.advanceTimersByTimeAsync(0)

    expect(postedHookNames(harness)).toEqual([
      'agent_start',
      'agent_end',
      'agent_start',
      'agent_end'
    ])
  })

  it('reports a child that started before any turn in this session, and clears when it ends', async () => {
    const harness = createPi()
    startAsync(harness, 'run-a', 'scout')
    await vi.advanceTimersByTimeAsync(0)
    complete(harness, 'run-a')
    await vi.advanceTimersByTimeAsync(0)

    // Why: LOCAL(nplez1) — this lane opens no run of its own for a child, so its whole report is
    // the live set: the child joins it and leaves it, and the pane's hold is read from those sets.
    expect(postedHookNames(harness)).toEqual(['subagent_async_state', 'subagent_async_state'])
    expect(postedSubagentRunIds(harness)).toEqual([['run-a'], []])
  })

  it('keeps working when a dialog closes while a child runs, whether or not the turn has ended', async () => {
    const harness = createPi()
    await harness.callHook('agent_start')
    startAsync(harness, 'run-a', 'scout')
    await harness.callHook('ui_prompt_start', {})
    await harness.callHook('ui_prompt_end', {}, idle)
    await vi.advanceTimersByTimeAsync(0)
    // Why: LOCAL(nplez1) — the pane is held receiver-side from the live `subagent_runs` set, so
    // nothing is withheld at source and the dialog closes as idle.
    expect(posts(harness).at(-1)).toMatchObject({
      hook_event_name: 'ui_prompt_end',
      is_idle: true
    })

    await endTurn(harness)
    await harness.callHook('ui_prompt_start', {})
    await harness.callHook('ui_prompt_end', {}, idle)
    await vi.advanceTimersByTimeAsync(0)
    // Why: the child is visible as the live set on whatever post follows the dialog.
    expect(postedSubagentRunIds(harness).at(-1)).toEqual(['run-a'])

    complete(harness, 'run-a')
    await vi.advanceTimersByTimeAsync(0)
    expect(postedHookNames(harness).at(-1)).toBe('subagent_async_state')
    expect(postedSubagentRunIds(harness).at(-1)).toEqual([])
  })
})

describe('OMP session switches', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // OMP keeps one registration and one SessionManager across a switch.
  function ompSession() {
    let id = 'A'
    const context = {
      sessionManager: { getSessionId: () => id, getSessionFile: () => `/sessions/${id}.jsonl` }
    }
    return { context, switchTo: (next: string) => (id = next) }
  }

  async function holdOmpRunOpen(harness: AgentStatusExtensionHarness, context: HookContext) {
    await harness.callHook('agent_start', {}, context)
    harness.emitPiEvent('task:subagent:lifecycle', { id: 'c1', agent: 'task', status: 'started' })
    await harness.callHook('agent_end', {}, context)
    await vi.advanceTimersByTimeAsync(0)
  }

  it('ends the held run under the session that ran it and forgets its children', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    const { context, switchTo } = ompSession()
    await holdOmpRunOpen(harness, context)
    expect(agentEndCount(harness)).toBe(0)

    switchTo('B')
    await harness.callHook(
      'session_switch',
      { reason: 'new', previousSessionFile: '/sessions/A.jsonl' },
      context
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(posts(harness).at(-1)).toMatchObject({ hook_event_name: 'agent_end', session_id: 'A' })
    expect(posts(harness).at(-1)?.subagents).toBeUndefined()

    await harness.callHook('agent_start', {}, context)
    await vi.advanceTimersByTimeAsync(0)
    expect(posts(harness).at(-1)).toMatchObject({ hook_event_name: 'agent_start', session_id: 'B' })
    expect(posts(harness).at(-1)?.subagents).toBeUndefined()
  })

  it('ends a turn the switch cut off, under the session that ran it', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    const { context, switchTo } = ompSession()
    await harness.callHook('agent_start', {}, context)
    switchTo('B')
    await harness.callHook(
      'session_switch',
      { reason: 'new', previousSessionFile: '/sessions/A.jsonl' },
      context
    )
    await vi.advanceTimersByTimeAsync(0)

    expect(posts(harness).at(-1)).toMatchObject({ hook_event_name: 'agent_end', session_id: 'A' })
  })

  it('keeps the children when OMP reloads the same session', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    const { context } = ompSession()
    await holdOmpRunOpen(harness, context)
    await harness.callHook(
      'session_switch',
      { reason: 'resume', previousSessionFile: '/sessions/A.jsonl' },
      context
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(agentEndCount(harness)).toBe(0)

    harness.emitPiEvent('task:subagent:lifecycle', { id: 'c1', status: 'completed' })
    await vi.advanceTimersByTimeAsync(0)
    expect(posts(harness).at(-1)).toMatchObject({ hook_event_name: 'agent_end', session_id: 'A' })
  })

  it.each(['fork', 'resume'] as const)(
    'keeps the children on a %s into another session, where OMP leaves them running',
    async (reason) => {
      const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
      const { context, switchTo } = ompSession()
      await holdOmpRunOpen(harness, context)
      switchTo('B')
      await harness.callHook(
        'session_switch',
        { reason, previousSessionFile: '/sessions/A.jsonl' },
        context
      )
      await vi.advanceTimersByTimeAsync(0)
      expect(agentEndCount(harness)).toBe(0)

      harness.emitPiEvent('task:subagent:lifecycle', { id: 'c1', status: 'completed' })
      await vi.advanceTimersByTimeAsync(0)
      expect(posts(harness).at(-1)).toMatchObject({ hook_event_name: 'agent_end' })
    }
  )

  it('ends the held run when OMP branches the session', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    const { context, switchTo } = ompSession()
    await holdOmpRunOpen(harness, context)
    switchTo('B')
    await harness.callHook('session_branch', { previousSessionFile: '/sessions/A.jsonl' }, context)
    await vi.advanceTimersByTimeAsync(0)

    expect(posts(harness).at(-1)).toMatchObject({ hook_event_name: 'agent_end', session_id: 'A' })
    expect(posts(harness).at(-1)?.subagents).toBeUndefined()
  })

  it('keeps a completion that was still waiting to be sent when OMP starts a new session', async () => {
    const releases: (() => void)[] = []
    const harness = createAgentStatusExtensionHarness({
      kind: 'omp',
      fetchImpl: () =>
        new Promise((resolve) => {
          releases.push(() => resolve({ ok: true }))
        })
    })
    const { context, switchTo } = ompSession()
    await harness.callHook('agent_start', {}, context)
    await harness.callHook('agent_end', {}, context)
    switchTo('B')
    await harness.callHook(
      'session_switch',
      { reason: 'new', previousSessionFile: '/sessions/A.jsonl' },
      context
    )
    await harness.callHook('agent_start', {}, context)

    while (releases.length > 0) {
      releases.shift()?.()
      await vi.advanceTimersByTimeAsync(0)
    }
    expect(posts(harness).slice(-2)).toMatchObject([
      { hook_event_name: 'agent_end', session_id: 'A' },
      { hook_event_name: 'agent_start', session_id: 'B' }
    ])
  })

  it.each(['omp', 'pi'] as const)(
    'takes over a roster and its subscriptions that an older build left on the %s bus',
    async (kind) => {
      const harness = createAgentStatusExtensionHarness({
        kind,
        sharedEventBus: true,
        seedEventBus: (bus) => {
          Object.assign(bus, {
            __orcaPiSubagents: {
              active: new Set(['old-child']),
              waiting: false,
              listener: () => {},
              runnerExitListener: () => {}
            }
          })
        }
      })
      expect(harness.piEventListenerCount('task:subagent:lifecycle')).toBe(0)
      // Why: LOCAL(nplez1) — upstream's roster binds the runner-exit channel only for a bus it has
      // not heard of, and only the fork's pi bus binds it of its own accord (patch:
      // local(pi-descendants)), so a bus an older build left behind gets that one on pi and none
      // on omp.
      expect(harness.piEventListenerCount('subagent:process-terminal')).toBe(kind === 'pi' ? 1 : 0)

      await harness.callHook('agent_start')
      await vi.advanceTimersByTimeAsync(0)
      expect(childIds(posts(harness).at(-1))).toEqual(['old-child'])
    }
  )

  it('posts nothing for a resume before any turn has run', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    const { context } = ompSession()
    await harness.callHook(
      'session_switch',
      { reason: 'resume', previousSessionFile: '/sessions/A.jsonl' },
      context
    )
    await vi.advanceTimersByTimeAsync(0)

    expect(posts(harness)).toEqual([])
  })

  it('keeps the next session’s children off the old session’s last post', async () => {
    const releases: (() => void)[] = []
    const harness = createAgentStatusExtensionHarness({
      kind: 'omp',
      fetchImpl: () =>
        new Promise((resolve) => {
          releases.push(() => resolve({ ok: true }))
        })
    })
    const { context, switchTo } = ompSession()
    await holdOmpRunOpen(harness, context)
    switchTo('B')
    await harness.callHook(
      'session_switch',
      { reason: 'new', previousSessionFile: '/sessions/A.jsonl' },
      context
    )
    harness.emitPiEvent('task:subagent:lifecycle', { id: 'c2', agent: 'task', status: 'started' })

    while (releases.length > 0) {
      releases.shift()?.()
      await vi.advanceTimersByTimeAsync(0)
    }
    const completion = posts(harness).find((post) => post.hook_event_name === 'agent_end')
    expect(completion).toMatchObject({ session_id: 'A' })
    expect(completion?.subagents).toBeUndefined()
    expect(childIds(posts(harness).at(-1))).toEqual(['c2'])
  })

  it('ends a turn that a reload of the same session cut off', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    const { context } = ompSession()
    await harness.callHook('agent_start', {}, context)
    await harness.callHook(
      'session_switch',
      { reason: 'resume', previousSessionFile: '/sessions/A.jsonl' },
      context
    )
    await vi.advanceTimersByTimeAsync(0)

    expect(posts(harness).at(-1)).toMatchObject({ hook_event_name: 'agent_end', session_id: 'A' })

    // The turn is over, so a child that starts now re-opens the run.
    harness.emitPiEvent('task:subagent:lifecycle', { id: 'w1', agent: 'task', status: 'started' })
    harness.emitPiEvent('task:subagent:lifecycle', { id: 'w1', status: 'completed' })
    await vi.advanceTimersByTimeAsync(0)
    expect(postedHookNames(harness)).toEqual([
      'agent_start',
      'agent_end',
      'agent_start',
      'agent_end'
    ])
  })

  it('keeps describing the lead’s children after a task child registers on its own bus', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    await harness.callHook('session_start')
    harness.emitPiEvent('task:subagent:lifecycle', { id: 'c1', agent: 'task', status: 'started' })
    await vi.advanceTimersByTimeAsync(0)
    harness.registerTaskChild()
    harness.emitPiEvent('task:subagent:lifecycle', { id: 'c2', agent: 'task', status: 'started' })
    await vi.advanceTimersByTimeAsync(0)

    expect(childIds(posts(harness).at(-1))).toEqual(['c1', 'c2'])
  })

  it('ignores a task child’s own subagents, which run on that child’s bus', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    await harness.callHook('agent_start')
    harness.emitPiEvent('task:subagent:lifecycle', { id: 'c1', agent: 'task', status: 'started' })
    await vi.advanceTimersByTimeAsync(0)
    const emitOnChildBus = harness.registerTaskChild()
    emitOnChildBus('task:subagent:lifecycle', { id: 'g1', agent: 'task', status: 'started' })
    emitOnChildBus('task:subagent:lifecycle', { id: 'g1', status: 'completed' })
    await vi.advanceTimersByTimeAsync(0)

    expect(postedHookNames(harness)).toEqual(['agent_start', 'agent_start'])
  })
})
