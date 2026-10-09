import { describe, expect, it } from 'vitest'
import {
  createAgentStatusExtensionHarness,
  type AgentStatusExtensionHarness
} from './agent-status-extension-test-harness'

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve()
  }
}

describe('OMP session status ownership', () => {
  it.each(['omp', 'pi'] as const)(
    'fences child callbacks before they change %s pane metadata',
    async (kind) => {
      const harness = createAgentStatusExtensionHarness({ kind, argv: ['bun', '/opt/omp/bin/omp'] })
      const root = {
        sessionManager: { getSessionId: () => 'root', getSessionFile: () => '/root.jsonl' }
      }
      await harness.callHook('session_start', {}, root)
      await settle()
      harness.fetchMock.mockClear()
      const rootHandlers = { ...harness.handlers }
      harness.reload()
      const child = {
        sessionManager: { getSessionId: () => 'child', getSessionFile: () => '/child.jsonl' }
      }
      for (const name of [
        'session_start',
        'before_agent_start',
        'agent_start',
        'tool_call',
        'tool_execution_start',
        'tool_execution_end',
        'tool_approval_requested',
        'tool_approval_resolved',
        'message_end',
        'agent_end',
        'agent_settled'
      ]) {
        await harness.callHook(
          name,
          { message: { role: 'assistant', content: 'child answer' } },
          child
        )
        await settle()
      }
      expect(harness.fetchMock).not.toHaveBeenCalled()
      await rootHandlers.agent_start({}, root)
      await settle()
      await rootHandlers.agent_end({}, root)
      await settle()
      const bodies = harness.fetchMock.mock.calls.map((call) => JSON.parse(call[1].body))
      expect(bodies.map((body) => body.payload.session_id)).toEqual(['root', 'root'])
      expect(bodies.map((body) => body.payload.session_file)).toEqual([
        '/root.jsonl',
        '/root.jsonl'
      ])
      expect(bodies.at(-1).payload.hook_event_name).toBe('agent_end')
    }
  )

  it('preserves a headless owner through reload, new, and resume', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    let sessionId = 'initial'
    const root = {
      hasUI: false,
      sessionManager: { getSessionId: () => sessionId, getSessionFile: () => '/session.jsonl' }
    }
    await harness.callHook('session_start', {}, root)
    for (const next of ['initial', 'new', 'resumed']) {
      sessionId = next
      harness.reload()
      await harness.callHook('session_start', { reason: 'reload' }, root)
      await harness.callHook('agent_start', {}, root)
      await settle()
    }
    expect(
      harness.fetchMock.mock.calls.map((call) => JSON.parse(call[1].body).payload.session_id)
    ).toEqual(['initial', 'new', 'resumed'])
  })
  it('uses a distinct ownership key when pane and launch change before callbacks', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    const parent = {
      sessionManager: { getSessionId: () => 'parent', getSessionFile: () => '/parent.jsonl' }
    }
    const separate = {
      sessionManager: { getSessionId: () => 'separate', getSessionFile: () => '/separate.jsonl' }
    }
    await harness.callHook('session_start', {}, parent)
    harness.processEnv.ORCA_PANE_KEY = 'pane-2'
    harness.processEnv.ORCA_AGENT_LAUNCH_TOKEN = 'launch-2'
    harness.reload()
    await harness.callHook('agent_start', {}, separate)
    await settle()
    expect(JSON.parse(harness.fetchMock.mock.calls[0][1].body).payload.session_id).toBe('separate')
  })

  it('uses OMP parent metadata and nested task paths when the root already owns the pane', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    const rootFile = '/sessions/root.jsonl'
    const root = {
      sessionManager: {
        getSessionId: () => 'root',
        getSessionFile: () => rootFile,
        getHeader: () => ({ parentSession: undefined })
      }
    }
    await harness.callHook('session_start', {}, root)
    await settle()
    harness.fetchMock.mockClear()
    harness.reload()
    const child = {
      sessionManager: {
        getSessionId: () => 'child',
        getSessionFile: () => '/sessions/root/child.jsonl',
        getHeader: () => ({ parentSession: rootFile })
      }
    }
    await harness.callHook('agent_start', {}, child)
    await settle()
    expect(harness.fetchMock).not.toHaveBeenCalled()
  })

  it('normalizes Windows task transcript paths', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    const rootFile = 'C:\\Users\\orca\\root.jsonl'
    const root = {
      sessionManager: {
        getSessionId: () => 'root-win',
        getSessionFile: () => rootFile,
        getHeader: () => ({})
      }
    }
    await harness.callHook('session_start', {}, root)
    harness.reload()
    const child = {
      sessionManager: {
        getSessionId: () => 'child-win',
        getSessionFile: () => 'c:\\users\\orca\\root\\child.jsonl',
        getHeader: () => ({})
      }
    }
    await harness.callHook('agent_start', {}, child)
    await settle()
    expect(harness.fetchMock).not.toHaveBeenCalled()
  })
  it('keeps reporting for legacy callbacks without a session manager', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    await harness.callHook('agent_start')
    await settle()
    await harness.callHook('agent_end')
    await settle()
    expect(
      harness.fetchMock.mock.calls.map((call) => JSON.parse(call[1].body).payload.hook_event_name)
    ).toEqual(['agent_start', 'agent_end'])
  })
})

describe('OMP runtime session provenance', () => {
  it.each(['omp', 'pi'] as const)(
    'rejects an earlier child callback before it can claim the %s pane',
    async (kind) => {
      const harness = createAgentStatusExtensionHarness({ kind, argv: ['bun', '/opt/omp/bin/omp'] })
      const child = {
        agentKind: 'sub',
        hasUI: false,
        sessionManager: { getSessionId: () => 'child', getSessionFile: () => '/child.jsonl' }
      }
      await harness.callHook('session_start', {}, child)
      await harness.callHook('agent_start', {}, child)
      await settle()
      expect(harness.fetchMock).not.toHaveBeenCalled()
      harness.reload()
      const root = {
        agentKind: 'main',
        hasUI: false,
        sessionManager: { getSessionId: () => 'root', getSessionFile: () => '/root.jsonl' }
      }
      await harness.callHook('session_start', {}, root)
      await settle()
      harness.fetchMock.mockClear()
      await harness.callHook('agent_start', {}, root)
      await settle()
      expect(harness.fetchMock).toHaveBeenCalledTimes(1)
      expect(JSON.parse(harness.fetchMock.mock.calls[0][1].body).payload.session_id).toBe('root')
    }
  )

  it('allows a former child transcript resumed as the runtime main session', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    const root = {
      hasUI: false,
      sessionManager: {
        getSessionId: () => 'resumed-child',
        getSessionFile: () => '/sessions/parent/subagent/child.jsonl'
      }
    }
    await harness.callHook('session_start', {}, root)
    await harness.callHook('agent_start', {}, root)
    await settle()
    expect(JSON.parse(harness.fetchMock.mock.calls[0][1].body).payload.session_id).toBe(
      'resumed-child'
    )
  })
})

/** The same fence under a pi RUNTIME (no OMP argv): pi-subagents runs a child agent as a
 *  second in-process session that shares this pane's key, so the child's posts land on the
 *  pane. Identity there is the session FILE — pi replaces its SessionManager on /new, /fork
 *  and /resume, so the manager instance cannot stand for the pane the way it does under OMP. */
describe('Pi session status ownership', () => {
  const session = (id: string, file: string | undefined, parent?: string) => ({
    sessionManager: {
      getSessionId: () => id,
      getSessionFile: () => file,
      getHeader: () => (parent === undefined ? {} : { parentSession: parent })
    }
  })

  const postedPayloads = (
    fetchMock: AgentStatusExtensionHarness['fetchMock']
  ): { hook_event_name?: unknown; session_id?: unknown }[] =>
    fetchMock.mock.calls.map((call) => {
      const body: { payload?: { hook_event_name?: unknown; session_id?: unknown } } = JSON.parse(
        String(call[1]?.body)
      )
      return body.payload ?? {}
    })

  const postedHookNames = (fetchMock: AgentStatusExtensionHarness['fetchMock']): unknown[] =>
    postedPayloads(fetchMock).map((payload) => payload.hook_event_name)

  it('refuses an in-process child of the pane session, then still reports the pane', async () => {
    // existsSync: pi publishes session identity only for a transcript that exists on disk.
    const harness = createAgentStatusExtensionHarness({ kind: 'pi', existsSync: () => true })
    const rootFile = '/sessions/root.jsonl'
    const root = session('root', rootFile)
    await harness.callHook('session_start', {}, root)
    await harness.callHook('agent_start', {}, root)
    await settle()
    harness.fetchMock.mockClear()

    // pi-subagents creates the child with `parentSession: <the pane's live file>`, as a second
    // registration of this same module while the pane's own registration stays live.
    const child = session('child', '/sessions/child.jsonl', rootFile)
    const taskChild = harness.registerTaskChild()
    for (const name of [
      'session_start',
      'before_agent_start',
      'agent_start',
      'tool_execution_start',
      'tool_execution_end',
      'message_end',
      'agent_end',
      'agent_settled'
    ]) {
      await taskChild.callHook(
        name,
        { message: { role: 'assistant', content: 'child answer' } },
        child
      )
      await settle()
    }
    expect(harness.fetchMock).not.toHaveBeenCalled()

    // The pane's own run is what its completion belongs to, and it is still connected.
    await harness.callHook('tool_execution_start', {}, root)
    await harness.callHook('agent_end', {}, root)
    await settle()
    expect(postedHookNames(harness.fetchMock)).toEqual(['tool_execution_start', 'agent_end'])
    expect(postedPayloads(harness.fetchMock)[1].session_id).toBe('root')
  })

  it('refuses a reopened child whose parent is an older pane session', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi', existsSync: () => true })
    const rootFile = '/sessions/root.jsonl'
    await harness.callHook('session_start', {}, session('root', rootFile))
    await settle()
    harness.fetchMock.mockClear()

    // pi-subagents reopens a child from its saved transcript, and that child names the pane
    // file of the run that spawned it — not the file the pane is on now. Nothing about it says
    // 'child', so only the rule that a session_start must name the file the pane is leaving
    // keeps it from taking the pane.
    const reopened = session('reopened', '/sessions/reopened.jsonl', '/sessions/past.jsonl')
    const taskChild = harness.registerTaskChild()
    await taskChild.callHook('session_start', { reason: 'startup' }, reopened)
    await taskChild.callHook('agent_end', {}, reopened)
    await settle()
    expect(harness.fetchMock).not.toHaveBeenCalled()

    await harness.callHook('agent_end', {}, session('root', rootFile))
    await settle()
    expect(postedHookNames(harness.fetchMock)).toEqual(['agent_end'])
    expect(postedPayloads(harness.fetchMock)[0].session_id).toBe('root')
  })

  it('re-keys the pane when a session_start names the file the pane is leaving', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi', existsSync: () => true })
    const rootFile = '/sessions/root.jsonl'
    await harness.callHook('session_start', {}, session('root', rootFile))
    await settle()
    harness.fetchMock.mockClear()

    // A switch whose shutdown this registration never saw: pi still names the outgoing file.
    const nextFile = '/sessions/next.jsonl'
    const next = session('next', nextFile, rootFile)
    await harness.callHook('session_start', { reason: 'fork', previousSessionFile: rootFile }, next)
    await harness.callHook('agent_end', {}, next)
    await settle()
    expect(postedHookNames(harness.fetchMock)).toEqual(['session_start', 'agent_end'])
    expect(postedPayloads(harness.fetchMock)[0].session_id).toBe('next')
  })

  it('refuses a nested child and an unpersisted session while the pane has a file', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi', existsSync: () => true })
    const rootFile = '/sessions/root.jsonl'
    await harness.callHook('session_start', {}, session('root', rootFile))
    await settle()
    harness.fetchMock.mockClear()

    const childFile = '/sessions/child.jsonl'
    const taskChild = harness.registerTaskChild()
    await taskChild.callHook('agent_start', {}, session('child', childFile, rootFile))
    // A grandchild names the child, which the fence already refused.
    await taskChild.callHook(
      'agent_end',
      {},
      session('grandchild', '/sessions/grand.jsonl', childFile)
    )
    // A nested spawn runs in memory: no transcript, so never the pane's own session.
    await taskChild.callHook('agent_end', {}, session('memory-child', undefined))
    await settle()
    expect(harness.fetchMock).not.toHaveBeenCalled()
  })

  it.each(['new', 'fork', 'resume'] as const)(
    'keeps reporting through a %s handoff',
    async (reason) => {
      const harness = createAgentStatusExtensionHarness({ kind: 'pi', existsSync: () => true })
      const rootFile = '/sessions/root.jsonl'
      await harness.callHook('session_start', {}, session('root', rootFile))
      await settle()
      harness.fetchMock.mockClear()

      // Pi replaces the session and names the file it is switching to before the new one reports.
      const nextFile = '/sessions/next.jsonl'
      await harness.replacePiSession(reason, nextFile)
      const next = session('next', nextFile, rootFile)
      await harness.callHook('session_start', { reason }, next)
      await harness.callHook('agent_end', {}, next)
      await settle()
      expect(postedHookNames(harness.fetchMock)).toEqual(['session_start', 'agent_end'])
      expect(postedPayloads(harness.fetchMock)[0].session_id).toBe('next')
    }
  )

  it('adopts a pane restored into a forked session that has no owner yet', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi', existsSync: () => true })
    // Pi writes parentSession for a person's own /fork and /clone too, and every one of those
    // is the session a restored pane resumes into — so a first sight with a parent is the pane.
    const forked = session('forked', '/sessions/forked.jsonl', '/sessions/original.jsonl')
    await harness.callHook('session_start', { reason: 'startup' }, forked)
    await harness.callHook('agent_start', {}, forked)
    await settle()
    expect(postedHookNames(harness.fetchMock)).toEqual(['session_start', 'agent_start'])
    expect(postedPayloads(harness.fetchMock)[1].session_id).toBe('forked')
  })

  it('re-keys the pane when it is resumed into a session the fence refused', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi', existsSync: () => true })
    const rootFile = '/sessions/root.jsonl'
    await harness.callHook('session_start', {}, session('root', rootFile))
    await settle()
    // A child reports on the pane and is refused, so its file is in the refused set.
    const childFile = '/sessions/child.jsonl'
    const taskChild = harness.registerTaskChild()
    await taskChild.callHook('agent_start', {}, session('child', childFile, rootFile))
    await settle()
    harness.fetchMock.mockClear()

    // The person then resumes that transcript as the pane's own session. Pi names the file it is
    // switching to before the new session reports, and that has to outrank the refused set.
    await harness.replacePiSession('resume', childFile)
    const resumed = session('child', childFile)
    await harness.callHook(
      'session_start',
      { reason: 'resume', previousSessionFile: rootFile },
      resumed
    )
    await harness.callHook('agent_end', {}, resumed)
    await settle()
    expect(postedHookNames(harness.fetchMock)).toEqual(['session_start', 'agent_end'])
    expect(postedPayloads(harness.fetchMock)[1].session_id).toBe('child')
  })

  it('keeps a persisted child off an unpersisted pane, which has no file to key on', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi', existsSync: () => true })
    const pane = session('pane', undefined)
    await harness.callHook('session_start', {}, pane)
    await settle()
    harness.fetchMock.mockClear()

    // The pane's session has no transcript, so `file` is undefined for it and for nothing else:
    // a child that has one must not match it.
    const taskChild = harness.registerTaskChild()
    await taskChild.callHook(
      'session_start',
      { reason: 'startup' },
      session('child', '/sessions/child.jsonl')
    )
    await taskChild.callHook('agent_end', {}, session('child', '/sessions/child.jsonl'))
    await settle()
    expect(harness.fetchMock).not.toHaveBeenCalled()

    await harness.callHook('agent_end', {}, pane)
    await settle()
    expect(postedHookNames(harness.fetchMock)).toEqual(['agent_end'])
  })

  it('keeps a child out of an unpersisted pane that switched sessions', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi', existsSync: () => true })
    const pane = session('pane', undefined)
    await harness.callHook('session_start', {}, pane)
    await settle()
    // /new on a pane with no transcript: pi names no target file, so the switch is only announced.
    await harness.replacePiSession('new')
    await harness.callHook('session_start', { reason: 'new' }, pane)
    await settle()
    harness.fetchMock.mockClear()

    // The pane can never name a file, so that switch must have closed: a child's transcript
    // otherwise reads as the pane's own and the pane stops reporting for the rest of the process.
    const taskChild = harness.registerTaskChild()
    await taskChild.callHook('agent_start', {}, session('child', '/sessions/child.jsonl'))
    await settle()
    expect(harness.fetchMock).not.toHaveBeenCalled()

    await harness.callHook('agent_end', {}, pane)
    await settle()
    expect(postedHookNames(harness.fetchMock)).toEqual(['agent_end'])
  })

  it('keeps reporting when a session manager is unavailable', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    await harness.callHook('agent_start')
    await harness.callHook('agent_end')
    await settle()
    expect(postedHookNames(harness.fetchMock)).toEqual(['agent_start', 'agent_end'])
  })
})
