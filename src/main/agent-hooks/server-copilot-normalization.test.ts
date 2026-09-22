import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** A background shell start is registered from its RESULT (the tool that really backgrounded it),
 *  not from the PreToolUse — an async shell that finishes within `initial_wait` returns its output
 *  directly and must not be tracked as pending. */
function postCopilotBackgroundShell(shellId: number, options: { detach?: boolean } = {}): void {
  const toolInput = {
    command: 'pnpm test',
    description: `shell ${shellId}`,
    mode: 'async',
    ...(options.detach ? { detach: true } : {})
  }
  for (const body of [
    buildBody({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: toolInput }),
    buildBody({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: toolInput,
      tool_result: {
        text_result_for_llm: `<command started in ${
          options.detach ? 'detached ' : ''
        }background with shellId: ${shellId}>`
      }
    })
  ]) {
    _internals.normalizeHookPayload('copilot', body, 'production')
  }
}

describe('Copilot hook normalization', () => {
  it('UserPromptSubmit maps to working and captures the prompt', () => {
    const result = _internals.normalizeHookPayload(
      'copilot',
      buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'add a migration' }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.agentType).toBe('copilot')
    expect(result?.payload.prompt).toBe('add a migration')
  })

  it('accepts camelCase Copilot event names from older hook configs', () => {
    const result = _internals.normalizeHookPayload(
      'copilot',
      buildBody({ hook_event_name: 'userPromptSubmitted', prompt: 'camel event' }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.prompt).toBe('camel event')
  })

  it('captures the Copilot provider session from SessionStart and Stop', () => {
    const sessionId = '940237d9-c712-48e8-bca1-fd75fc4a8d4b'
    const started = _internals.normalizeHookPayload(
      'copilot',
      buildBody({ hook_event_name: 'SessionStart', session_id: sessionId }),
      'production'
    )
    expect(started?.providerSession).toEqual({ key: 'session_id', id: sessionId })

    const stopped = _internals.normalizeHookPayload(
      'copilot',
      buildBody({ hook_event_name: 'Stop', session_id: sessionId }),
      'production'
    )
    expect(stopped?.payload.state).toBe('done')
    expect(stopped?.providerSession).toEqual({ key: 'session_id', id: sessionId })
  })

  it('captures the Copilot provider session from a camelCase sessionId', () => {
    const result = _internals.normalizeHookPayload(
      'copilot',
      buildBody({ hookEventName: 'agentStop', sessionId: 'copilot-camel' }),
      'production'
    )
    expect(result?.providerSession).toEqual({ key: 'session_id', id: 'copilot-camel' })
  })

  it('infers Copilot user prompt payloads that omit hook_event_name', () => {
    const result = _internals.normalizeHookPayload(
      'copilot',
      buildBody({ prompt: 'raw prompt payload' }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.prompt).toBe('raw prompt payload')
  })

  it('captures initialPrompt from Copilot sessionStart payloads', () => {
    const result = _internals.normalizeHookPayload(
      'copilot',
      buildBody({ initialPrompt: 'first prompt' }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.prompt).toBe('first prompt')
  })

  it('PreToolUse stays working and surfaces tool context', () => {
    const result = _internals.normalizeHookPayload(
      'copilot',
      buildBody({
        hook_event_name: 'PreToolUse',
        toolName: 'bash',
        toolInput: { command: 'pnpm test' }
      }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.toolName).toBe('bash')
    expect(result?.payload.toolInput).toBe('pnpm test')
  })

  it('keeps a stopped Copilot turn monitoring a running background shell', () => {
    postCopilotBackgroundShell(0)

    const stopped = _internals.normalizeHookPayload(
      'copilot',
      buildBody({ hook_event_name: 'Stop' }),
      'production'
    )

    expect(stopped?.payload).toMatchObject({
      state: 'working',
      workingMode: 'monitoring',
      agentType: 'copilot'
    })
  })

  it('does not monitor a plain foreground shell command', () => {
    _internals.normalizeHookPayload(
      'copilot',
      buildBody({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'pnpm test', mode: 'sync' }
      }),
      'production'
    )

    const stopped = _internals.normalizeHookPayload(
      'copilot',
      buildBody({ hook_event_name: 'Stop' }),
      'production'
    )

    expect(stopped?.payload).toMatchObject({ state: 'done', agentType: 'copilot' })
    expect(stopped?.payload.workingMode).toBeUndefined()
  })

  it('settles a monitored Copilot turn after its background shell completes', () => {
    postCopilotBackgroundShell(0)
    _internals.normalizeHookPayload('copilot', buildBody({ hook_event_name: 'Stop' }), 'production')

    const completed = _internals.normalizeHookPayload(
      'copilot',
      buildBody({
        hook_event_name: 'Notification',
        notification_type: 'shell_completed',
        title: 'shell 0',
        message: 'Shell command "shell 0" (shellId: 0) has completed successfully.'
      }),
      'production'
    )

    expect(completed?.payload).toMatchObject({
      state: 'done',
      agentType: 'copilot'
    })
  })

  it('does not settle a stopped Copilot turn until every background shell completes', () => {
    postCopilotBackgroundShell(0, { detach: true })
    postCopilotBackgroundShell(1, { detach: true })
    _internals.normalizeHookPayload('copilot', buildBody({ hook_event_name: 'Stop' }), 'production')

    const firstCompleted = _internals.normalizeHookPayload(
      'copilot',
      buildBody({
        hook_event_name: 'Notification',
        notification_type: 'shell_detached_completed',
        title: 'shell 0',
        message: 'Detached shell "shell 0" (shellId: 0) has completed.'
      }),
      'production'
    )

    expect(firstCompleted).toBeNull()
  })

  it('does not let a completed background shell settle a later foreground turn', () => {
    postCopilotBackgroundShell(0)
    _internals.normalizeHookPayload('copilot', buildBody({ hook_event_name: 'Stop' }), 'production')
    _internals.normalizeHookPayload(
      'copilot',
      buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'check the result' }),
      'production'
    )

    const completed = _internals.normalizeHookPayload(
      'copilot',
      buildBody({
        hook_event_name: 'Notification',
        notification_type: 'shell_completed',
        title: 'shell 0',
        message: 'Shell command "shell 0" (shellId: 0) has completed successfully.'
      }),
      'production'
    )

    expect(completed).toBeNull()
  })

  it('keeps a stopped Copilot turn monitoring a running subagent', () => {
    _internals.normalizeHookPayload(
      'copilot',
      buildBody({ hook_event_name: 'subagentStart', agent_name: 'code-reviewer' }),
      'production'
    )
    const stopped = _internals.normalizeHookPayload(
      'copilot',
      buildBody({ hook_event_name: 'Stop' }),
      'production'
    )

    expect(stopped?.payload).toMatchObject({
      state: 'working',
      workingMode: 'monitoring',
      agentType: 'copilot'
    })
  })

  it('settles a monitored Copilot turn after its subagent stops', () => {
    _internals.normalizeHookPayload(
      'copilot',
      buildBody({ hook_event_name: 'subagentStart', agent_name: 'code-reviewer' }),
      'production'
    )
    _internals.normalizeHookPayload('copilot', buildBody({ hook_event_name: 'Stop' }), 'production')

    const stopped = _internals.normalizeHookPayload(
      'copilot',
      buildBody({ hook_event_name: 'SubagentStop', agent_name: 'code-reviewer' }),
      'production'
    )

    expect(stopped?.payload).toMatchObject({ state: 'done', agentType: 'copilot' })
  })

  it('settles a monitored general-purpose subagent after its completion notification', () => {
    _internals.normalizeHookPayload(
      'copilot',
      buildBody({
        hook_event_name: 'PreToolUse',
        tool_name: 'Agent',
        tool_input: { description: 'Inspect the build', mode: 'background' }
      }),
      'production'
    )
    _internals.normalizeHookPayload('copilot', buildBody({ hook_event_name: 'Stop' }), 'production')

    const completed = _internals.normalizeHookPayload(
      'copilot',
      buildBody({ hook_event_name: 'Notification', notification_type: 'agent_completed' }),
      'production'
    )

    expect(completed?.payload).toMatchObject({ state: 'done', agentType: 'copilot' })
  })

  it('does not monitor a stopped turn for a synchronous task subagent', () => {
    // Why: a sync `task` completes with its PostToolUse; counting it as background work stranded the
    // pane in monitoring for the rest of the session (the general-purpose agent emits no
    // subagentStart/subagentStop, so nothing decremented it).
    _internals.normalizeHookPayload(
      'copilot',
      buildBody({
        hook_event_name: 'PreToolUse',
        tool_name: 'Agent',
        tool_input: { description: 'Inspect the build', mode: 'sync' }
      }),
      'production'
    )
    _internals.normalizeHookPayload(
      'copilot',
      buildBody({
        hook_event_name: 'PostToolUse',
        tool_name: 'Agent',
        tool_input: { description: 'Inspect the build', mode: 'sync' },
        tool_result: { text_result_for_llm: 'done' }
      }),
      'production'
    )

    const stopped = _internals.normalizeHookPayload(
      'copilot',
      buildBody({ hook_event_name: 'Stop' }),
      'production'
    )

    expect(stopped?.payload).toMatchObject({ state: 'done', agentType: 'copilot' })
    expect(stopped?.payload.workingMode).toBeUndefined()
  })

  it('does not keep monitoring a background task whose launch failed', () => {
    // Why: the task tool rejects a missing agent name after PreToolUse already counted the launch;
    // without consuming it on the failure the pane stuck in monitoring for the session.
    for (const body of [
      buildBody({
        hook_event_name: 'PreToolUse',
        tool_name: 'Agent',
        tool_input: { description: 'Inspect the build', mode: 'background' }
      }),
      buildBody({
        hook_event_name: 'PostToolUseFailure',
        tool_name: 'Agent',
        tool_input: { description: 'Inspect the build', mode: 'background' },
        error: '"name": Required'
      })
    ]) {
      _internals.normalizeHookPayload('copilot', body, 'production')
    }

    const stopped = _internals.normalizeHookPayload(
      'copilot',
      buildBody({ hook_event_name: 'Stop' }),
      'production'
    )

    expect(stopped?.payload).toMatchObject({ state: 'done', agentType: 'copilot' })
    expect(stopped?.payload.workingMode).toBeUndefined()
  })

  it('monitors a background task subagent and settles it on agent_completed without a SubagentStop', () => {
    _internals.normalizeHookPayload(
      'copilot',
      buildBody({
        hook_event_name: 'PreToolUse',
        tool_name: 'Agent',
        tool_input: { description: 'Inspect the build', mode: 'background' }
      }),
      'production'
    )
    _internals.normalizeHookPayload(
      'copilot',
      buildBody({ hook_event_name: 'subagentStart', agent_name: 'general-purpose' }),
      'production'
    )

    const stopped = _internals.normalizeHookPayload(
      'copilot',
      buildBody({ hook_event_name: 'Stop' }),
      'production'
    )
    expect(stopped?.payload).toMatchObject({ state: 'working', workingMode: 'monitoring' })

    const completed = _internals.normalizeHookPayload(
      'copilot',
      buildBody({ hook_event_name: 'Notification', notification_type: 'agent_completed' }),
      'production'
    )

    expect(completed?.payload).toMatchObject({ state: 'done', agentType: 'copilot' })
  })

  it('keeps a Stop hook continuation working without entering monitoring mode', () => {
    const result = _internals.normalizeHookPayload(
      'copilot',
      buildBody({ hook_event_name: 'Stop', stop_hook_active: true }),
      'production'
    )

    expect(result?.payload).toMatchObject({ state: 'working', agentType: 'copilot' })
    expect(result?.payload.workingMode).toBeUndefined()
  })

  it('PostToolUseFailure surfaces the error and clears stale tool fields', () => {
    _internals.normalizeHookPayload(
      'copilot',
      buildBody({
        hook_event_name: 'PreToolUse',
        toolName: 'bash',
        toolInput: { command: 'pnpm test' }
      }),
      'production'
    )
    const failed = _internals.normalizeHookPayload(
      'copilot',
      buildBody({
        hook_event_name: 'PostToolUseFailure',
        toolName: 'bash',
        toolInput: { command: 'pnpm test' },
        error_message: 'command not found'
      }),
      'production'
    )
    // Why: keeping toolName would let the compact sidebar show the tool instead of the failure text, hiding the error.
    expect(failed?.payload).toMatchObject({
      state: 'working',
      lastAssistantMessage: 'command not found'
    })
    expect(failed?.payload.toolName).toBeUndefined()
    expect(failed?.payload.toolInput).toBeUndefined()
  })

  it('PreToolUse ask_user maps to blocked and surfaces the question', () => {
    _internals.normalizeHookPayload(
      'copilot',
      buildBody({ prompt: 'ask me a question' }),
      'production'
    )
    const result = _internals.normalizeHookPayload(
      'copilot',
      buildBody({
        toolCalls: [
          {
            name: 'ask_user',
            args: JSON.stringify({ question: 'Which deployment target should I use?' })
          }
        ]
      }),
      'production'
    )
    expect(result?.payload.state).toBe('blocked')
    expect(result?.payload.prompt).toBe('ask me a question')
    expect(result?.payload.toolName).toBe('ask_user')
    expect(result?.payload.toolInput).toBe('Which deployment target should I use?')
    expect(result?.payload.lastAssistantMessage).toBe('Which deployment target should I use?')
  })

  it('PermissionRequest stays working and preserves tool context', () => {
    const result = _internals.normalizeHookPayload(
      'copilot',
      buildBody({
        hook_event_name: 'PermissionRequest',
        tool_name: 'bash',
        tool_input: { command: 'rm -rf /tmp/orca-test' }
      }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.toolName).toBe('bash')
    expect(result?.payload.toolInput).toBe('rm -rf /tmp/orca-test')
  })

  it('surfaces lowercase Copilot file tool input previews', () => {
    const result = _internals.normalizeHookPayload(
      'copilot',
      buildBody({
        hook_event_name: 'PreToolUse',
        tool_name: 'edit',
        tool_input: { path: '/repo/src/app.ts' }
      }),
      'production'
    )
    expect(result?.payload.toolName).toBe('edit')
    expect(result?.payload.toolInput).toBe('/repo/src/app.ts')
  })

  it('Notification(permission_prompt) maps to blocked and surfaces message text', () => {
    const result = _internals.normalizeHookPayload(
      'copilot',
      buildBody({
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        title: 'Approval needed',
        message: 'Allow Bash to run?'
      }),
      'production'
    )
    expect(result?.payload.state).toBe('blocked')
    expect(result?.payload.lastAssistantMessage).toBe('Allow Bash to run?')
  })

  it('keeps PermissionRequest working until the CLI actually prompts, then blocks', () => {
    // Why: PermissionRequest also fires for requests a rule auto-approves, so only the
    // notification — emitted once a prompt is shown (copilot-cli 1.0.26, copilot-cli#2586) — may block.
    const states = [
      buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'clean the cache' }),
      buildBody({
        hook_event_name: 'PreToolUse',
        tool_name: 'bash',
        tool_input: { command: 'rm -rf /tmp/orca-cache' }
      }),
      buildBody({
        hook_event_name: 'PermissionRequest',
        tool_name: 'bash',
        tool_input: { command: 'rm -rf /tmp/orca-cache' }
      }),
      buildBody({
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        message: 'Allow Bash to run?'
      }),
      buildBody({
        hook_event_name: 'PostToolUse',
        tool_name: 'bash',
        tool_input: { command: 'rm -rf /tmp/orca-cache' },
        tool_result: { text_result_for_llm: 'removed' }
      })
    ].map((body) => _internals.normalizeHookPayload('copilot', body, 'production')?.payload.state)

    expect(states).toEqual(['working', 'working', 'working', 'blocked', 'working'])
  })

  it('Notification(elicitation_dialog) preserves the cached prompt', () => {
    _internals.normalizeHookPayload(
      'copilot',
      buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'deploy the app' }),
      'production'
    )
    const result = _internals.normalizeHookPayload(
      'copilot',
      buildBody({
        hook_event_name: 'Notification',
        notification_type: 'elicitation_dialog',
        message: 'Which environment?'
      }),
      'production'
    )
    expect(result?.payload.state).toBe('blocked')
    expect(result?.payload.prompt).toBe('deploy the app')
    expect(result?.payload.lastAssistantMessage).toBe('Which environment?')
    expect(result?.hasExplicitPrompt).toBe(false)
  })

  it('Notification(elicitation_dialog) accepts camelCase type and surfaces the question', () => {
    const result = _internals.normalizeHookPayload(
      'copilot',
      buildBody({
        hook_event_name: 'Notification',
        notificationType: 'elicitation_dialog',
        message: 'Which deployment target should I use?'
      }),
      'production'
    )
    expect(result?.payload.state).toBe('blocked')
    expect(result?.payload.lastAssistantMessage).toBe('Which deployment target should I use?')
  })

  it('later progress clears a prior blocked state for the same pane', () => {
    _internals.normalizeHookPayload(
      'copilot',
      buildBody({
        hook_event_name: 'PermissionRequest',
        tool_name: 'bash',
        tool_input: { command: 'pnpm build' }
      }),
      'production'
    )
    const result = _internals.normalizeHookPayload(
      'copilot',
      buildBody({
        hook_event_name: 'PostToolUse',
        tool_name: 'bash',
        tool_input: { command: 'pnpm build' },
        tool_result: { text_result_for_llm: 'build passed' }
      }),
      'production'
    )
    expect(result?.payload.state).toBe('working')
    expect(result?.payload.lastAssistantMessage).toBe('build passed')
  })

  it('Stop reads the final assistant message from Copilot transcript events', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'orca-copilot-transcript-'))
    const transcriptPath = join(tmpDir, 'events.jsonl')
    try {
      const lines = [
        {
          type: 'assistant.message',
          data: {
            content: '',
            toolRequests: [{ name: 'bash', arguments: { command: 'pnpm test' } }]
          }
        },
        {
          type: 'assistant.message',
          data: { content: 'Done - tests pass now.', toolRequests: [] }
        }
      ]
      writeFileSync(transcriptPath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)

      const result = _internals.normalizeHookPayload(
        'copilot',
        buildBody({ hook_event_name: 'Stop', transcript_path: transcriptPath }),
        'production'
      )

      expect(result?.payload.state).toBe('done')
      expect(result?.payload.lastAssistantMessage).toBe('Done - tests pass now.')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('unknown event name returns null', () => {
    const result = _internals.normalizeHookPayload(
      'copilot',
      buildBody({ hook_event_name: 'somethingElse' }),
      'production'
    )
    expect(result).toBeNull()
  })

  it('accepts authenticated HTTP posts on /hook/copilot', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const listener = vi.fn()
      server.setListener(listener)
      const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/copilot`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
        },
        body: JSON.stringify(
          buildBody({ hook_event_name: 'Notification', notificationType: 'elicitation_dialog' })
        )
      })

      expect(response.status).toBe(204)
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          paneKey: PANE,
          payload: expect.objectContaining({ state: 'blocked', agentType: 'copilot' })
        })
      )
    } finally {
      server.stop()
    }
  })

  it('accepts a Copilot permission prompt over HTTP as blocked', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const listener = vi.fn()
      server.setListener(listener)
      const response = await postHookEvent(
        server,
        buildBody({
          hook_event_name: 'Notification',
          notification_type: 'permission_prompt',
          message: 'Allow Bash to run?'
        }),
        '/hook/copilot'
      )

      expect(response.status).toBe(204)
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          paneKey: PANE,
          payload: expect.objectContaining({ state: 'blocked', agentType: 'copilot' })
        })
      )
    } finally {
      server.stop()
    }
  })

  it('updates Copilot Stop with final transcript text after a non-blocking retry', async () => {
    const server = new AgentHookServer()
    const tmpDir = mkdtempSync(join(tmpdir(), 'orca-copilot-transcript-retry-'))
    const transcriptPath = join(tmpDir, 'events.jsonl')
    writeFileSync(transcriptPath, '')
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const listener = vi.fn()
      server.setListener(listener)

      await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/copilot`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
        },
        body: JSON.stringify(
          buildBody({
            hook_event_name: 'PostToolUse',
            tool_result: { text_result_for_llm: 'stale tool output' }
          })
        )
      })
      const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/copilot`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
        },
        body: JSON.stringify(
          buildBody({ hook_event_name: 'Stop', transcript_path: transcriptPath })
        )
      })

      expect(response.status).toBe(204)
      await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/copilot`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
        },
        body: JSON.stringify(buildBody({ hook_event_name: 'SessionEnd', reason: 'complete' }))
      })
      expect(listener).toHaveBeenLastCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            state: 'done',
            lastAssistantMessage: undefined
          })
        })
      )

      // Let the first 50ms retry miss so continuation across SessionEnd is proven.
      await new Promise((resolve) => setTimeout(resolve, 70))
      writeFileSync(
        transcriptPath,
        `${JSON.stringify({
          type: 'assistant.message',
          data: { content: 'Done after transcript flush.' }
        })}\n`
      )
      await new Promise((resolve) => setTimeout(resolve, 120))

      expect(listener).toHaveBeenLastCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            state: 'done',
            lastAssistantMessage: 'Done after transcript flush.'
          })
        })
      )
    } finally {
      server.stop()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('updates Grok Stop with final chat-history text after a non-blocking retry', async () => {
    const server = new AgentHookServer()
    const tmpDir = mkdtempSync(join(tmpdir(), 'orca-grok-chat-history-retry-'))
    const sessionId = '019e37f4-5135-7b63-a4ab-6d13aa6bf528'
    const cwd = join(tmpDir, 'workspace')
    const sessionDir = join(tmpDir, '.grok', 'sessions', encodeURIComponent(cwd), sessionId)
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, 'chat_history.jsonl'), '')
    vi.stubEnv('HOME', tmpDir)
    vi.stubEnv('USERPROFILE', tmpDir)
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const listener = vi.fn()
      server.setListener(listener)

      await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/grok`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
        },
        body: JSON.stringify(buildBody({ hookEventName: 'user_prompt_submit', prompt: 'hihi' }))
      })
      const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/grok`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
        },
        body: JSON.stringify(buildBody({ hookEventName: 'Stop', sessionId, cwd }))
      })

      expect(response.status).toBe(204)
      expect(listener).toHaveBeenLastCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            state: 'done',
            lastAssistantMessage: undefined
          })
        })
      )

      writeFileSync(
        join(sessionDir, 'chat_history.jsonl'),
        `${JSON.stringify({ type: 'assistant', content: 'Hi! How can I help you today?' })}\n`
      )
      await new Promise((resolve) => setTimeout(resolve, 120))

      expect(listener).toHaveBeenLastCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            state: 'done',
            lastAssistantMessage: 'Hi! How can I help you today?'
          })
        })
      )
    } finally {
      server.stop()
      vi.unstubAllEnvs()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
