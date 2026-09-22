import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import type { RuntimeClientEvent } from '../../../shared/runtime-client-events'
import { SETUP_RUNNER_WATCHDOG_MS } from '../orca-runtime-setup-runner-state'
import {
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  antigravityPromptBeforeModelReadyScreen,
  antigravityReadyScreen,
  store,
  syncSinglePty
} from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  /** 133;D also emits a `terminalSideEffects` fact; these tests only assert on the state event. */
  function setupRunnerEvents(events: readonly RuntimeClientEvent[]): RuntimeClientEvent[] {
    return events.filter((event) => event.type === 'worktreeSetupRunnerState')
  }

  /** A runtime with one live PTY whose setup runner has just been armed. */
  async function startArmedSetupRunner(ptyId: string): Promise<{
    runtime: OrcaRuntimeService
    events: RuntimeClientEvent[]
    handle: string
  }> {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: ptyId }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const events: RuntimeClientEvent[] = []
    runtime.onClientEvent((event) => events.push(event))
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    runtime.armWorktreeSetupRunner(handle, TEST_WORKTREE_ID, `token-${ptyId}`)
    expect(setupRunnerEvents(events)).toEqual([
      { type: 'worktreeSetupRunnerState', worktreeId: TEST_WORKTREE_ID, running: true }
    ])
    return { runtime, events, handle }
  }

  it('waits for exit on background terminal handles', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)

    const waiting = runtime.waitForTerminal(handle, { condition: 'exit', timeoutMs: 1000 })
    runtime.onPtyExit('pty-bg', 7)

    await expect(waiting).resolves.toMatchObject({
      handle,
      condition: 'exit',
      status: 'exited',
      exitCode: 7
    })
    await expect(runtime.readTerminal(handle)).resolves.toMatchObject({
      status: 'exited'
    })
  })

  it('observes setup command completion without waiting for its interactive shell to exit', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-setup' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    ;(
      runtime as unknown as { setupCompletionTokenByPtyId: Map<string, string> }
    ).setupCompletionTokenByPtyId.set('pty-setup', 'token-live')

    const waiting = runtime.waitForSetupTerminalCompletion(handle)
    runtime.onPtyData(
      'pty-setup',
      'setup failed\r\n__ORCA_SETUP_COMPLETE__:token-live:17\r\nPS>',
      100
    )

    await expect(waiting).resolves.toEqual({ exitCode: 17 })
    await expect(runtime.readTerminal(handle)).resolves.toMatchObject({ status: 'running' })
  })

  it('replays fast setup completion emitted before its observer is registered', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-fast-setup' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    ;(
      runtime as unknown as { setupCompletionTokenByPtyId: Map<string, string> }
    ).setupCompletionTokenByPtyId.set('pty-fast-setup', 'token-fast')
    runtime.onPtyData(
      'pty-fast-setup',
      '__ORCA_SETUP_COMPLETE__:wrong:9\r\n__ORCA_SETUP_COMPLETE__:token-fast:0\r\n$',
      100
    )

    await expect(runtime.waitForSetupTerminalCompletion(handle)).resolves.toEqual({ exitCode: 0 })
  })

  it('falls back to setup terminal exit when no completion signal is available', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-legacy-setup' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)

    const waiting = runtime.waitForSetupTerminalCompletion(handle)
    runtime.onPtyExit('pty-legacy-setup', 9)

    await expect(waiting).resolves.toEqual({ exitCode: 9 })
  })

  it('cancels setup completion observation when the caller aborts', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-cancelled-setup' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    ;(
      runtime as unknown as { setupCompletionTokenByPtyId: Map<string, string> }
    ).setupCompletionTokenByPtyId.set('pty-cancelled-setup', 'token-cancelled')
    const unsubscribe = vi.fn()
    vi.spyOn(runtime, 'subscribeToTerminalData').mockReturnValue(unsubscribe)
    const controller = new AbortController()

    const waiting = runtime.waitForSetupTerminalCompletion(handle, controller.signal)
    expect(runtime.subscribeToTerminalData).toHaveBeenCalledWith(
      'pty-cancelled-setup',
      expect.any(Function)
    )

    const reason = new Error('cancelled')
    controller.abort(reason)

    await expect(waiting).rejects.toBe(reason)
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('keeps observing after an uncertain setup terminal status', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-uncertain-setup' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    ;(
      runtime as unknown as { setupCompletionTokenByPtyId: Map<string, string> }
    ).setupCompletionTokenByPtyId.set('pty-uncertain-setup', 'token-uncertain')
    vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
      handle,
      condition: 'exit',
      satisfied: false,
      status: 'unknown',
      exitCode: null
    })

    const waiting = runtime.waitForSetupTerminalCompletion(handle)
    await Promise.resolve()
    runtime.onPtyData('pty-uncertain-setup', '__ORCA_SETUP_COMPLETE__:token-uncertain:0\r\n', 100)

    await expect(waiting).resolves.toEqual({ exitCode: 0 })
  })

  it('drops retained PTY transcript memory when a background terminal exits', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)

    runtime.onPtyData(
      'pty-bg',
      `${Array.from({ length: 20 }, (_, i) => `line-${i}`).join('\n')}\nwrote /tmp/exited-result.json\n`,
      100
    )
    await expect(runtime.readTerminal(handle)).resolves.toMatchObject({
      status: 'running',
      tail: expect.arrayContaining(['line-0'])
    })

    runtime.onPtyExit('pty-bg', 0)

    const pty = (
      runtime as unknown as {
        ptysById: Map<
          string,
          {
            tailBuffer: string[]
            tailPartialLine: string
            tailLinesTotal: number
            tailTruncated: boolean
          }
        >
        recentPtyPathCandidatesById: Map<string, string[]>
      }
    ).ptysById.get('pty-bg')
    expect(pty).toMatchObject({
      tailBuffer: [],
      tailPartialLine: '',
      tailLinesTotal: 0,
      tailTruncated: false
    })
    await expect(runtime.readTerminal(handle)).resolves.toMatchObject({
      status: 'exited',
      tail: []
    })
    expect(
      (
        runtime as unknown as { recentPtyPathCandidatesById: Map<string, string[]> }
      ).recentPtyPathCandidatesById.has('pty-bg')
    ).toBe(false)
  })

  it('bounds disconnected background PTY records and their synthetic handles', async () => {
    let nextPtyIndex = 0
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockImplementation(async () => ({ id: `pty-bg-${nextPtyIndex++}` })),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const handles: string[] = []
    for (let index = 0; index < 140; index += 1) {
      const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
      handles.push(handle)
      runtime.onPtyData(`pty-bg-${index}`, `wrote /tmp/result-${index}.json\n`, 100 + index)
      runtime.onPtyExit(`pty-bg-${index}`, 0)
    }

    const internals = runtime as unknown as {
      ptysById: Map<string, unknown>
      handles: Map<string, unknown>
      handleByPtyId: Map<string, string>
      recentPtyPathCandidatesById: Map<string, string[]>
    }
    expect(internals.ptysById.size).toBeLessThanOrEqual(128)
    expect(internals.ptysById.has('pty-bg-0')).toBe(false)
    expect(internals.ptysById.has('pty-bg-139')).toBe(true)
    expect(internals.handleByPtyId.has('pty-bg-0')).toBe(false)
    expect(internals.handles.has(handles[0]!)).toBe(false)
    expect(internals.recentPtyPathCandidatesById.has('pty-bg-0')).toBe(false)

    await expect(runtime.readTerminal(handles[0]!)).rejects.toThrow('terminal_handle_stale')
    await expect(runtime.readTerminal(handles.at(-1)!)).resolves.toMatchObject({
      status: 'exited'
    })
  })

  it('keeps retained PTY transcript memory when controller refresh omits a record', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    runtime.registerPty('daemon-pty-1', TEST_WORKTREE_ID)
    runtime.onPtyData('daemon-pty-1', 'still live\npartial', 100)

    await runtime.listTerminals()

    const pty = (
      runtime as unknown as {
        ptysById: Map<
          string,
          {
            connected: boolean
            tailBuffer: string[]
            tailPartialLine: string
            tailLinesTotal: number
          }
        >
      }
    ).ptysById.get('daemon-pty-1')
    expect(pty).toMatchObject({
      connected: false,
      tailBuffer: ['still live'],
      tailPartialLine: 'partial',
      tailLinesTotal: 1
    })
  })

  it('keeps retained PTY transcript memory when controller refresh fails', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => {
        throw new Error('controller unavailable')
      }
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    runtime.registerPty('daemon-pty-1', TEST_WORKTREE_ID)
    runtime.onPtyData('daemon-pty-1', 'still live\npartial', 100)

    await runtime.listTerminals()

    const pty = (
      runtime as unknown as {
        ptysById: Map<
          string,
          {
            connected: boolean
            tailBuffer: string[]
            tailPartialLine: string
            tailLinesTotal: number
          }
        >
      }
    ).ptysById.get('daemon-pty-1')
    expect(pty).toMatchObject({
      connected: true,
      tailBuffer: ['still live'],
      tailPartialLine: 'partial',
      tailLinesTotal: 1
    })
  })

  it('keeps retained PTY transcript memory when controller refresh times out', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null,
        listProcesses: () => new Promise(() => {})
      })
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      runtime.registerPty('daemon-pty-1', TEST_WORKTREE_ID)
      runtime.onPtyData('daemon-pty-1', 'still live\npartial', 100)

      const terminals = runtime.listTerminals()
      await vi.advanceTimersByTimeAsync(3_000)
      await terminals

      const pty = (
        runtime as unknown as {
          ptysById: Map<
            string,
            {
              connected: boolean
              tailBuffer: string[]
              tailPartialLine: string
              tailLinesTotal: number
            }
          >
        }
      ).ptysById.get('daemon-pty-1')
      expect(pty).toMatchObject({
        connected: true,
        tailBuffer: ['still live'],
        tailPartialLine: 'partial',
        tailLinesTotal: 1
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolves tui-idle for adopted background PTY handles from the renderer title', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-bg',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Codex ready',
          activeLeafId: 'pane-bg',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-bg',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane-bg',
          paneRuntimeId: 1,
          ptyId: 'pty-bg',
          paneTitle: null
        }
      ]
    })

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({
      handle,
      condition: 'tui-idle',
      status: 'running'
    })
  })

  it('resolves live-leaf tui-idle from an OpenCode native title', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    syncSinglePty(runtime, 'remote:pty-1', {
      tabTitle: 'repo terminal',
      paneTitle: 'ssh build-host | OC | Native session'
    })
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(
      runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({
      handle: terminal.handle,
      condition: 'tui-idle',
      status: 'running'
    })
  })

  it('does not treat a Codex launch title as tui-idle readiness', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const serializeProviderBuffer = vi.fn().mockResolvedValue({
        data: 'OpenAI Codex\r\nmodel: gpt-5.5\r\ndirectory: /repo\r\n',
        cols: 80,
        rows: 24,
        seq: 1
      })
      runtime.setPtyController({
        spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null,
        serializeProviderBuffer
      })
      const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)

      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: 'tab-bg',
            worktreeId: TEST_WORKTREE_ID,
            title: 'Codex YOLO',
            activeLeafId: 'pane-bg',
            layout: null
          }
        ],
        leaves: [
          {
            tabId: 'tab-bg',
            worktreeId: TEST_WORKTREE_ID,
            leafId: 'pane-bg',
            paneRuntimeId: 1,
            ptyId: 'pty-bg',
            paneTitle: null
          }
        ]
      })

      const waitPromise = runtime.waitForTerminal(handle, {
        condition: 'tui-idle',
        timeoutMs: 1_000
      })
      const timeoutAssertion = expect(waitPromise).rejects.toThrow('timeout')

      await vi.advanceTimersByTimeAsync(2_000)

      await timeoutAssertion
      expect(serializeProviderBuffer).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolves tui-idle from a Codex ready prompt preview', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    runtime.onPtyData(
      'pty-bg',
      [
        ' >_ OpenAI Codex (v0.131.0)\n',
        ' model:       gpt-5.5 high   /model to change\n',
        ' directory:   ~/orca/workspaces/orca/cli-debug\n'
      ].join(''),
      Date.now()
    )

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({
      handle,
      condition: 'tui-idle',
      status: 'running'
    })
  })

  it('resolves tui-idle from an Antigravity ready prompt preview', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    runtime.onPtyData('pty-bg', antigravityReadyScreen('Gemini 4 Experimental (High)'), Date.now())

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({
      handle,
      condition: 'tui-idle',
      status: 'running'
    })
  })

  it('resolves Antigravity ready prompts with newline-heavy pasted tails without splitting', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    let pastedTail = ''
    for (let index = 0; index < 90; index += 1) {
      pastedTail += `${'pasted text '.repeat(25)}${index}\n`
    }
    const splitSpy = vi.spyOn(String.prototype, 'split')

    runtime.onPtyData(
      'pty-bg',
      [
        'Antigravity CLI 1.0.3\n',
        'user@example.com (Antigravity Business)\n',
        pastedTail,
        'Gemini 4 Experimental (High)\n',
        '~/orca/workspaces/orca/agy-dispatch-issue\n',
        '>'
      ].join(''),
      Date.now()
    )

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({
      handle,
      condition: 'tui-idle',
      satisfied: true,
      status: 'running'
    })
    const splitReadyTail = splitSpy.mock.contexts.some((context) => {
      const value = typeof context === 'string' ? context : String(context)
      return value.includes('antigravity cli') && value.includes('pasted text pasted text')
    })
    expect(splitReadyTail).toBe(false)
  })

  it('resolves tui-idle from an Antigravity prompt before the model line', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    runtime.onPtyData(
      'pty-bg',
      [
        'Do you trust this workspace directory?\n',
        'Press t to trust\n',
        antigravityPromptBeforeModelReadyScreen('Gemini 3.5 Flash (High)')
      ].join(''),
      Date.now()
    )

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({
      handle,
      condition: 'tui-idle',
      satisfied: true,
      status: 'running'
    })
  })

  it('resolves live-leaf tui-idle from an Antigravity ready prompt preview', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Terminal',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1',
          paneTitle: null
        }
      ]
    })
    runtime.onPtyData('pty-1', antigravityReadyScreen(), Date.now())
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(
      runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({
      handle: terminal.handle,
      condition: 'tui-idle',
      status: 'running'
    })
  })

  it('announces a worktree as setting up until its runner reports completion', async () => {
    const { runtime, events, handle } = await startArmedSetupRunner('pty-setup-state')

    // Why: a renderer reload while setup runs gets this on subscribe instead of
    // the already-emitted 'running' event, which it never saw.
    expect(runtime.getSetupRunnerClientEventSnapshot()).toEqual([
      { type: 'worktreeSetupRunnerState', worktreeId: TEST_WORKTREE_ID, running: true }
    ])

    runtime.onPtyData(
      'pty-setup-state',
      '__ORCA_SETUP_COMPLETE__:token-pty-setup-state:0\r\n$',
      100
    )

    // Why: the runner's interactive shell stays alive, so only the completion
    // marker (not a PTY exit) may clear the state.
    await vi.waitFor(() => expect(events).toHaveLength(2))
    expect(events[1]).toEqual({
      type: 'worktreeSetupRunnerState',
      worktreeId: TEST_WORKTREE_ID,
      running: false
    })
    expect(runtime.getSetupRunnerClientEventSnapshot()).toEqual([])
    await expect(runtime.readTerminal(handle)).resolves.toMatchObject({ status: 'running' })
  })

  it('does not announce setup for a handle that is already gone', () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-setup-absent' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const events: RuntimeClientEvent[] = []
    runtime.onClientEvent((event) => events.push(event))

    // Why: announcing 'running' for a runner that already ended would strand the dot.
    runtime.armWorktreeSetupRunner('handle-never-issued', TEST_WORKTREE_ID, 'token-absent')

    expect(events).toEqual([])
  })

  it('clears setting-up when the runner is interrupted before its marker prints', async () => {
    const { runtime, events } = await startArmedSetupRunner('pty-setup-interrupt')

    // Why: Ctrl+C kills the wrapped command line before the wrapper's marker
    // runs, so only the prompt returning (OSC 133;D) reports the abort.
    runtime.onPtyData('pty-setup-interrupt', '^C\r\n\x1b]133;D;130\x07\r\n$ ', 100)

    expect(setupRunnerEvents(events)).toEqual([
      { type: 'worktreeSetupRunnerState', worktreeId: TEST_WORKTREE_ID, running: true },
      { type: 'worktreeSetupRunnerState', worktreeId: TEST_WORKTREE_ID, running: false }
    ])
  })

  it('clears setting-up when the setup PTY exits, and does not resurrect it', async () => {
    const { runtime, events } = await startArmedSetupRunner('pty-setup-exit')

    runtime.onPtyExit('pty-setup-exit', 1)

    expect(setupRunnerEvents(events)).toHaveLength(2)
    expect(setupRunnerEvents(events)[1]).toEqual({
      type: 'worktreeSetupRunnerState',
      worktreeId: TEST_WORKTREE_ID,
      running: false
    })
    expect(runtime.getSetupRunnerClientEventSnapshot()).toEqual([])

    // Why: a repeated exit, or the completion that raced it, must not re-announce.
    runtime.onPtyExit('pty-setup-exit', 1)
    runtime.onPtyData('pty-setup-exit', '__ORCA_SETUP_COMPLETE__:token-pty-setup-exit:0\r\n$', 101)
    expect(setupRunnerEvents(events)).toHaveLength(2)
  })

  it('clears setting-up when a runner never reports an end at all', async () => {
    vi.useFakeTimers()
    try {
      const { runtime, events } = await startArmedSetupRunner('pty-setup-wedged')

      // Why: a shell wedged in its own rc never runs the queued setup command, so
      // no OSC 133, no marker, and no exit ever arrive while the PTY stays alive.
      await vi.advanceTimersByTimeAsync(SETUP_RUNNER_WATCHDOG_MS + 1)

      expect(events).toHaveLength(2)
      expect(events[1]).toMatchObject({ running: false })
      expect(runtime.getSetupRunnerClientEventSnapshot()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a worktree setting up until every runner for it has ended', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi
        .fn()
        .mockResolvedValueOnce({ id: 'pty-setup-first' })
        .mockResolvedValueOnce({ id: 'pty-setup-second' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const events: RuntimeClientEvent[] = []
    runtime.onClientEvent((event) => events.push(event))
    const first = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'setup-a'
    })
    const second = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'setup-b'
    })
    expect(second.handle).not.toBe(first.handle)

    runtime.armWorktreeSetupRunner(first.handle, TEST_WORKTREE_ID, 'token-first')
    runtime.armWorktreeSetupRunner(second.handle, TEST_WORKTREE_ID, 'token-second')
    expect(setupRunnerEvents(events)).toHaveLength(1)

    runtime.onPtyData('pty-setup-first', '\x1b]133;D;0\x07', 100)
    // Why: the other runner for this worktree is still going, so the dot stays.
    expect(runtime.getSetupRunnerClientEventSnapshot()).toHaveLength(1)
    expect(setupRunnerEvents(events)).toHaveLength(1)

    runtime.onPtyData('pty-setup-second', '\x1b]133;D;0\x07', 100)
    expect(runtime.getSetupRunnerClientEventSnapshot()).toEqual([])
    expect(setupRunnerEvents(events)).toHaveLength(2)
    expect(setupRunnerEvents(events)[1]).toMatchObject({ running: false })
  })
})
