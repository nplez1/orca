import { beforeEach, describe, expect, it, vi } from 'vitest'
import { _internals } from './server'
import { buildBody } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn(() => null) }))

const LEAD = 'b34b9719-ec1e-48f9-a2c2-b5f5cd3fa027'
const CHILD = 'b06590fb-e8a9-4fe8-aa0c-ed6469093cde'
const RESUMED = '82b50ea2-114c-41f7-a49f-f560a52f75b7'

beforeEach(() => {
  _internals.resetCachesForTests()
})

function post(body: Record<string, unknown>): ReturnType<typeof _internals.normalizeHookPayload> {
  return _internals.normalizeHookPayload('copilot', buildBody(body), 'production')
}

/** Copilot subagents run as their own session on the lead pane: the CLI tags their turn/tool hooks
 *  with the child `session_id` (only their permission hooks carry the lead's). */
describe('Copilot subagent session attribution', () => {
  it('does not let a subagent prompt replace the lead turn prompt', () => {
    post({ hook_event_name: 'UserPromptSubmit', session_id: LEAD, prompt: 'do the thing' })
    expect(
      post({ hook_event_name: 'UserPromptSubmit', session_id: CHILD, prompt: 'list files' })
    ).toBeNull()

    const leadTool = post({
      hook_event_name: 'PreToolUse',
      session_id: LEAD,
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' }
    })

    expect(leadTool?.payload.prompt).toBe('do the thing')
  })

  it('does not let a subagent Stop settle the lead pane', () => {
    post({ hook_event_name: 'UserPromptSubmit', session_id: LEAD, prompt: 'do the thing' })
    post({ hook_event_name: 'PreToolUse', session_id: LEAD, tool_name: 'Bash' })

    expect(post({ hook_event_name: 'Stop', session_id: CHILD })).toBeNull()

    const leadStop = post({ hook_event_name: 'Stop', session_id: LEAD })
    expect(leadStop?.payload.state).toBe('done')
  })

  it('does not let a subagent tool event overwrite the lead tool fields', () => {
    post({ hook_event_name: 'UserPromptSubmit', session_id: LEAD, prompt: 'do the thing' })
    post({
      hook_event_name: 'PreToolUse',
      session_id: LEAD,
      tool_name: 'Bash',
      tool_input: { command: 'lead command' }
    })
    expect(
      post({
        hook_event_name: 'PreToolUse',
        session_id: CHILD,
        tool_name: 'Bash',
        tool_input: { command: 'child command' }
      })
    ).toBeNull()

    const leadTool = post({
      hook_event_name: 'PostToolUse',
      session_id: LEAD,
      tool_name: 'Bash',
      tool_result: { text_result_for_llm: 'ok' }
    })

    expect(leadTool?.payload.toolInput).toBe('lead command')
  })

  it('drops events from a superseded lead session after a resume', () => {
    post({ hook_event_name: 'UserPromptSubmit', session_id: LEAD, prompt: 'first' })
    post({
      hook_event_name: 'SessionStart',
      session_id: RESUMED,
      source: 'resume',
      initial_prompt: 'resumed'
    })

    expect(post({ hook_event_name: 'Stop', session_id: LEAD })).toBeNull()
    expect(post({ hook_event_name: 'Stop', session_id: RESUMED })?.payload.state).toBe('done')
  })
})

/** A subagent's background shell is still the pane's work, and a completion must be matched to the
 *  shell it names rather than consuming whichever shell happens to be pending. */
describe('Copilot background shell tracking', () => {
  function startShell(sessionId: string, description: string): Record<string, unknown> {
    return {
      hook_event_name: 'PreToolUse',
      session_id: sessionId,
      tool_name: 'Bash',
      tool_input: { command: 'sleep 60', description, mode: 'async' }
    }
  }

  function shellStarted(sessionId: string, description: string, shellId: number) {
    return {
      hook_event_name: 'PostToolUse',
      session_id: sessionId,
      tool_name: 'Bash',
      tool_input: { command: 'sleep 60', description, mode: 'async' },
      tool_result: {
        text_result_for_llm: `<command started in background with shellId: ${shellId}>`
      }
    }
  }

  function shellComplete(description: string, shellId: number) {
    return {
      hook_event_name: 'Notification',
      sessionId: LEAD,
      notification_type: 'shell_completed',
      title: description,
      message: `Shell command "${description}" (shellId: ${shellId}) has completed successfully.`
    }
  }

  function workingLeadShell(shellId: number): void {
    post({ hook_event_name: 'UserPromptSubmit', session_id: LEAD, prompt: 'go' })
    post(startShell(LEAD, 'lead shell'))
    post(shellStarted(LEAD, 'lead shell', shellId))
    expect(post({ hook_event_name: 'Stop', session_id: LEAD })?.payload).toMatchObject({
      state: 'working'
    })
  }

  function startWorkingLeadShellAndSubagent(): void {
    post({ hook_event_name: 'UserPromptSubmit', session_id: LEAD, prompt: 'go' })
    post(startShell(LEAD, 'lead shell'))
    post(shellStarted(LEAD, 'lead shell', 0))
    post({
      hook_event_name: 'PreToolUse',
      session_id: LEAD,
      tool_name: 'Agent',
      tool_input: { name: 'reviewer', mode: 'background' }
    })
    post({ hook_event_name: 'subagentStart', sessionId: LEAD, agentName: 'reviewer' })

    expect(post({ hook_event_name: 'Stop', session_id: LEAD })?.payload).toMatchObject({
      state: 'working'
    })
  }

  it('stays working when the shell finishes before its background subagent', () => {
    startWorkingLeadShellAndSubagent()

    expect(post(shellComplete('lead shell', 0))).toBeNull()
    expect(post({ hook_event_name: 'SubagentStop', session_id: LEAD })?.payload.state).toBe('done')
  })

  it('stays working when the subagent finishes before its background shell', () => {
    startWorkingLeadShellAndSubagent()

    expect(post({ hook_event_name: 'SubagentStop', session_id: LEAD })).toBeNull()
    expect(post(shellComplete('lead shell', 0))?.payload.state).toBe('done')
  })

  it('tracks a subagent shell so its completion cannot consume the lead shell', () => {
    workingLeadShell(0)
    expect(post(startShell(CHILD, 'child shell'))).toBeNull()
    expect(post(shellStarted(CHILD, 'child shell', 1))).toBeNull()

    expect(post(shellComplete('child shell', 1))).toBeNull()
    expect(post(shellComplete('lead shell', 0))?.payload.state).toBe('done')
  })

  it('ignores a completion for a shell it never saw start', () => {
    workingLeadShell(0)

    expect(post(shellComplete('some other shell', 9))).toBeNull()
    expect(post(shellComplete('lead shell', 0))?.payload.state).toBe('done')
  })

  it('does not let a redundant agent completion consume a pending shell', () => {
    workingLeadShell(0)

    expect(
      post({
        hook_event_name: 'Notification',
        sessionId: LEAD,
        notification_type: 'agent_completed'
      })
    ).toBeNull()
    expect(post(shellComplete('lead shell', 0))?.payload.state).toBe('done')
  })

  // Why: a subagent's own subagent reports yet another session id. Classifying against the pane's
  // ONE lead id (not a fixed child list) is what makes arbitrary nesting work.
  it('tracks shells and subagents through two nesting levels and settles last', () => {
    const childOne = 'child-one-session'
    const childTwo = 'child-two-session'

    post({ hook_event_name: 'UserPromptSubmit', session_id: LEAD, prompt: 'go' })
    post(startShell(LEAD, 'lead shell'))
    post(shellStarted(LEAD, 'lead shell', 0))
    post({
      hook_event_name: 'PreToolUse',
      session_id: LEAD,
      tool_name: 'Agent',
      tool_input: { name: 'first', mode: 'background' }
    })
    post({ hook_event_name: 'subagentStart', sessionId: LEAD, agentName: 'first' })

    // A nested subagent launched by a child session, tagged with that child's own id.
    expect(
      post({ hook_event_name: 'UserPromptSubmit', session_id: childOne, prompt: 'nested' })
    ).toBeNull()
    expect(
      post({
        hook_event_name: 'PreToolUse',
        session_id: childOne,
        tool_name: 'Agent',
        tool_input: { name: 'second', mode: 'background' }
      })
    ).toBeNull()
    expect(
      post({ hook_event_name: 'subagentStart', sessionId: childOne, agentName: 'second' })
    ).toBeNull()

    // A shell started by the deepest subagent, tagged with its own id.
    expect(post(startShell(childTwo, 'nested shell'))).toBeNull()
    expect(post(shellStarted(childTwo, 'nested shell', 2))).toBeNull()

    expect(post({ hook_event_name: 'Stop', session_id: LEAD })?.payload).toMatchObject({
      state: 'working'
    })

    // Completions arrive in a mixed, non-nesting order.
    expect(post(shellComplete('nested shell', 2))).toBeNull()
    expect(post(shellComplete('lead shell', 0))).toBeNull()
    expect(
      post({
        hook_event_name: 'Notification',
        sessionId: LEAD,
        notification_type: 'agent_completed'
      })
    ).toBeNull()
    expect(post({ hook_event_name: 'SubagentStop', session_id: LEAD })?.payload.state).toBe('done')
  })

  it('keeps the pane working when a nested subagent starts a shell after the lead stopped', () => {
    post({ hook_event_name: 'UserPromptSubmit', session_id: LEAD, prompt: 'go' })
    post({
      hook_event_name: 'PreToolUse',
      session_id: LEAD,
      tool_name: 'Agent',
      tool_input: { name: 'first', mode: 'background' }
    })
    post({ hook_event_name: 'subagentStart', sessionId: LEAD, agentName: 'first' })
    expect(post({ hook_event_name: 'Stop', session_id: LEAD })?.payload).toMatchObject({
      state: 'working'
    })

    // The stopped lead's child starts its own background shell; the pane must stay working.
    expect(post(startShell('deep-session', 'deep shell'))).toBeNull()
    expect(post(shellStarted('deep-session', 'deep shell', 3))).toBeNull()
    expect(post(shellComplete('deep shell', 3))).toBeNull()

    expect(post({ hook_event_name: 'SubagentStop', session_id: LEAD })?.payload.state).toBe('done')
  })

  it('does not monitor an async shell that finished within initial_wait', () => {
    // Why: an async shell that finishes inside initial_wait returns its output directly (never
    // `started in background`), so nothing will ever report it complete; tracking it would strand
    // the pane in Working.
    post({ hook_event_name: 'UserPromptSubmit', session_id: LEAD, prompt: 'go' })
    post(startShell(LEAD, 'inline shell'))
    post({
      hook_event_name: 'PostToolUse',
      session_id: LEAD,
      tool_name: 'Bash',
      tool_input: { command: 'sleep 1', description: 'inline shell', mode: 'async' },
      tool_result: { text_result_for_llm: '<shellId: 0 completed with exit code 0>' }
    })

    const stopped = post({ hook_event_name: 'Stop', session_id: LEAD })
    expect(stopped?.payload).toMatchObject({ state: 'done' })
    expect(stopped?.payload.workingMode).toBeUndefined()
  })

  it('settles a background shell the agent reads to completion instead of waiting for a notification', () => {
    // Why: the real nested run read its shell with read_bash and Copilot then suppressed the
    // shell_completed notification; the read result is the only completion signal.
    workingLeadShell(0)

    expect(
      post({
        hook_event_name: 'PostToolUse',
        session_id: LEAD,
        tool_name: 'read_bash',
        tool_input: { shellId: '0', delay: 20 },
        tool_result: { text_result_for_llm: '\n<shellId: 0 completed with exit code 0>' }
      })
    ).not.toBeNull()

    expect(post({ hook_event_name: 'Stop', session_id: LEAD })?.payload.state).toBe('done')
  })
})
