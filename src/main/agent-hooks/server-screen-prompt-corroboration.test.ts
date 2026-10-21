import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentHookSource } from '../../shared/agent-hook-relay'
import { AgentHookServer, _internals } from './server'
import {
  SCREEN_PROMPT_FAST_RECHECK_COUNT,
  ScreenPromptCorroboration,
  screenPromptReleaseRow,
  screenPromptRow
} from './server/server-screen-prompt-corroboration'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'
import type { EnrichedAgentHookEventPayload } from './server/server-types'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({ track: trackMock }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: getCohortAtEmitMock }))

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue(null)
})

afterEach(() => {
  vi.restoreAllMocks()
})

function row(
  state: EnrichedAgentHookEventPayload['payload']['state'],
  overrides: Partial<EnrichedAgentHookEventPayload> = {}
): EnrichedAgentHookEventPayload {
  return {
    paneKey: PANE,
    source: 'copilot',
    connectionId: null,
    receivedAt: 1_000,
    stateStartedAt: 1_000,
    turnStartedAt: 900,
    payload: { state, prompt: 'review the diff', agentType: 'copilot' },
    ...overrides
  }
}

describe('the row a screen dialog implies', () => {
  it('repaints a working Copilot row as a wait', () => {
    const armed = row('working')
    const next = screenPromptRow(armed, armed, {
      reason: 'agent-approval-prompt',
      since: 1_200
    })
    expect(next?.payload.state).toBe('waiting')
    // Why the event name: the row it repaints is the agent's own event, not a new hook.
    expect(next?.hookEventName).toBe('screen_prompt')
  })

  it('keeps the identity readers join on', () => {
    // Why: a row assembled from scratch drops these, and the headless mobile path then loses its
    // resume target (#10630) — the screen only changes the state, never who the pane is.
    const armed = row('working', {
      providerSession: { key: 'session_id', id: 'copilot-session' },
      launchToken: 'launch-1',
      terminalHandle: 'term-1',
      hostTurnRevision: 'rev-7',
      toolAgentId: 'child-1',
      promptInteractionKey: 'draw-1',
      agentPresence: { agent: 'copilot', ended: true },
      payload: {
        state: 'working',
        prompt: 'review the diff',
        agentType: 'copilot',
        toolName: 'bash',
        toolInput: 'gh pr diff'
      }
    })
    const next = screenPromptRow(armed, armed, {
      reason: 'agent-approval-prompt',
      since: 1_200
    })
    expect(next?.providerSession?.id).toBe('copilot-session')
    expect(next?.launchToken).toBe('launch-1')
    expect(next?.terminalHandle).toBe('term-1')
    expect(next?.hostTurnRevision).toBe('rev-7')
    expect(next?.toolAgentId).toBe('child-1')
    expect(next?.promptInteractionKey).toBe('draw-1')
    expect(next?.agentPresence).toEqual({ agent: 'copilot', ended: true })
    expect(next?.payload.toolName).toBe('bash')
    expect(next?.payload.toolInput).toBe('gh pr diff')
  })

  it('drops the clocks it would otherwise claim as fresh observations', () => {
    const armed = row('working')
    const next = screenPromptRow(armed, armed, {
      reason: 'agent-approval-prompt',
      since: 1_200
    })
    expect(next).not.toHaveProperty('receivedAt')
    expect(next).not.toHaveProperty('stateStartedAt')
    expect(next).not.toHaveProperty('turnStartedAt')
  })

  it('does not read a dialog painted before this turn', () => {
    // Why: an answered dialog stays in the tail; only wording gained during the turn is a wait.
    expect(
      screenPromptRow(row('working'), row('working'), {
        reason: 'agent-interactive-prompt',
        since: 500
      })
    ).toBeNull()
  })

  it('does nothing once a newer hook event owns the pane', () => {
    const armed = row('working')
    expect(
      screenPromptRow(armed, row('working', { receivedAt: 2_000 }), {
        reason: 'agent-approval-prompt',
        since: 1_200
      })
    ).toBeNull()
  })

  it('leaves agents whose hooks report their own dialogs alone', () => {
    const claude = row('working', {
      source: 'claude',
      payload: { state: 'working', prompt: 'review the diff', agentType: 'claude' }
    })
    expect(
      screenPromptRow(claude, claude, { reason: 'agent-approval-prompt', since: 1_200 })
    ).toBeNull()
  })

  it('ignores a screen reason that is not a person being asked', () => {
    const armed = row('working')
    expect(
      screenPromptRow(armed, armed, { reason: 'agent-trust-workspace', since: 1_200 })
    ).toBeNull()
  })

  it('needs no corroboration for a row that already reads waiting', () => {
    const waiting = row('waiting')
    expect(
      screenPromptRow(waiting, waiting, { reason: 'agent-approval-prompt', since: 1_200 })
    ).toBeNull()
  })

  it('releases the wait back to the row the screen displaced', () => {
    const released = screenPromptReleaseRow(row('working'))
    expect(released.payload.state).toBe('working')
    expect(released.hookEventName).toBe('screen_prompt_cleared')
  })
})

describe('a Copilot approval that only the screen reports', () => {
  let userDataPath: string
  let server: AgentHookServer
  let screen: { reason: 'agent-approval-prompt'; since: number } | null

  beforeEach(async () => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-screen-prompt-'))
    screen = null
    server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    server.setScreenPromptReader((paneKey) =>
      paneKey === PANE && screen ? { ...screen, since: Date.now() } : null
    )
  })

  afterEach(() => {
    server.stop()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  function states(): string[] {
    return server.getStatusSnapshotForPane(PANE).map((entry) => entry.state)
  }

  async function post(payload: Record<string, unknown>, source: AgentHookSource = 'copilot') {
    await postHookEvent(server, buildBody(payload), `/hook/${source}`)
  }

  it('waits on screen evidence and returns to working once the dialog is gone', async () => {
    screen = { reason: 'agent-approval-prompt', since: 0 }
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'run gh pr diff' })
    await post({ hook_event_name: 'PermissionRequest', tool_name: 'bash' })
    await vi.waitFor(() => expect(states()).toEqual(['waiting']), { timeout: 4_000 })

    // Why the re-read: nothing posts when a person answers, and PostToolUse comes only when the
    // approved command has finished, so the dialog leaving the screen is the end of the wait.
    screen = null
    await vi.waitFor(() => expect(states()).toEqual(['working']), { timeout: 4_000 })
  })

  it('keeps working when no dialog is on screen (a request the CLI approved itself)', async () => {
    let reads = 0
    server.setScreenPromptReader(() => {
      reads += 1
      return null
    })
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'rm -rf /tmp/x' })
    await post({ hook_event_name: 'PermissionRequest', tool_name: 'bash' })
    // Why the read count: a fixed sleep could pass before the deferred read ever ran.
    await vi.waitFor(() => expect(reads).toBeGreaterThan(0), { timeout: 4_000 })
    expect(states()).toEqual(['working'])
  })

  it('lets the next hook event supersede the wait', async () => {
    screen = { reason: 'agent-approval-prompt', since: 0 }
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'run gh pr diff' })
    await post({ hook_event_name: 'PermissionRequest', tool_name: 'bash' })
    await vi.waitFor(() => expect(states()).toEqual(['waiting']), { timeout: 4_000 })

    screen = null
    await post({ hook_event_name: 'PostToolUse', tool_name: 'bash' })
    await vi.waitFor(() => expect(states()).toEqual(['working']), { timeout: 4_000 })
  })

  it('reads the screen the moment a dialog appears, without waiting for a hook', async () => {
    // Why: a dialog painted well after the agent's last hook leaves nothing to defer on.
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'run gh pr diff' })
    expect(states()).toEqual(['working'])
    screen = { reason: 'agent-approval-prompt', since: 0 }
    server.noteScreenPromptGained(PANE)
    await vi.waitFor(() => expect(states()).toEqual(['waiting']), { timeout: 2_000 })
  })

  it('ends a wait row restored after a restart', async () => {
    // Why: hydration writes rows without arming anything, so a wait row that comes back would
    // otherwise sit on Needs You forever - the dialog closed while Orca was away.
    screen = { reason: 'agent-approval-prompt', since: 0 }
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'run gh pr diff' })
    await post({ hook_event_name: 'PermissionRequest', tool_name: 'bash' })
    await vi.waitFor(() => expect(states()).toEqual(['waiting']), { timeout: 4_000 })
    server.flushStatusPersistSync()
    server.stop({ keepStatus: true })

    const restarted = new AgentHookServer()
    restarted.setScreenPromptReader(() => null)
    await restarted.start({ env: 'production', userDataPath })
    try {
      await vi.waitFor(
        () =>
          expect(restarted.getStatusSnapshotForPane(PANE).map((entry) => entry.state)).toEqual([
            'working'
          ]),
        { timeout: 6_000 }
      )
    } finally {
      restarted.stop()
    }
  })

  it('keeps the pane identity and tool line on the repainted row', async () => {
    screen = { reason: 'agent-approval-prompt', since: 0 }
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'run gh pr diff' })
    await post({ hook_event_name: 'PermissionRequest', tool_name: 'bash' })
    await vi.waitFor(() => expect(states()).toEqual(['waiting']), { timeout: 4_000 })
    const [waiting] = server.getStatusSnapshotForPane(PANE)
    expect(waiting?.paneKey).toBe(PANE)
    expect(waiting?.prompt).toBe('run gh pr diff')
    expect(waiting?.toolName).toBe('bash')
  })
})

describe('the corroboration loop', () => {
  let published: EnrichedAgentHookEventPayload[]
  let reads: number
  let screen: { reason: 'agent-approval-prompt'; since: number } | null
  let current: EnrichedAgentHookEventPayload
  /** Stands in for the store: every write re-enters arm(), exactly as commitStatusRowMutation does. */
  let commit: (row: EnrichedAgentHookEventPayload) => void

  beforeEach(() => {
    vi.useFakeTimers()
    published = []
    reads = 0
    screen = { reason: 'agent-approval-prompt', since: 1_200 }
    current = row('working')
    commit = () => {}
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function corroboration() {
    const loop = new ScreenPromptCorroboration({
      readsScreen: () => true,
      readScreenPrompt: () => {
        reads += 1
        return screen
      },
      currentRow: () => current,
      publishScreenPromptRow: (next) => {
        current = { ...next, receivedAt: current.receivedAt + 1, stateStartedAt: 1 }
        published.push(current)
        commit(current)
        return current.receivedAt
      }
    })
    commit = (row) => loop.arm(row)
    return loop
  }

  it('never reads a row another host owns', () => {
    current = row('working', { connectionId: 'conn-1' })
    const loop = corroboration()
    loop.arm(current)
    vi.advanceTimersByTime(10_000)
    expect(reads).toBe(0)
    expect(published).toHaveLength(0)
  })

  it('reads once after the delay, then keeps watching while its wait stands', () => {
    const loop = corroboration()
    loop.arm(current)
    expect(reads).toBe(0)
    vi.advanceTimersByTime(250)
    expect(published.map((entry) => entry.payload.state)).toEqual(['waiting'])
    // Why: nothing posts when the person answers, so the loop must keep looking until it clears.
    vi.advanceTimersByTime(1_000)
    expect(reads).toBe(2)
    screen = null
    vi.advanceTimersByTime(1_000)
    expect(published.map((entry) => entry.payload.state)).toEqual(['waiting', 'working'])
  })

  it('keeps reading after it releases, so a dialog that comes back is caught again', () => {
    const loop = corroboration()
    loop.arm(current)
    vi.advanceTimersByTime(250)
    screen = null
    vi.advanceTimersByTime(1_000)
    expect(published.at(-1)?.payload.state).toBe('working')
    // Why: had the release cancelled the read its own write scheduled, nothing would see this.
    screen = { reason: 'agent-approval-prompt', since: 1_200 }
    vi.advanceTimersByTime(250)
    expect(published.at(-1)?.payload.state).toBe('waiting')
  })

  it('ignores a second scan report while its read is already in flight', () => {
    const loop = corroboration()
    loop.arm(current)
    expect(reads).toBe(0)
    loop.noteDialogGained(PANE)
    expect(reads).toBe(0)
    vi.advanceTimersByTime(250)
    expect(published.at(-1)?.payload.state).toBe('waiting')
  })

  it('slows its re-reads instead of stopping them', () => {
    const loop = corroboration()
    loop.arm(current)
    // Why exact: the fast phase is one read per second for ten reads, then one per five seconds.
    vi.advanceTimersByTime(250)
    expect(reads).toBe(1)
    vi.advanceTimersByTime(SCREEN_PROMPT_FAST_RECHECK_COUNT * 1_000)
    expect(reads).toBe(1 + SCREEN_PROMPT_FAST_RECHECK_COUNT)
    const before = reads
    vi.advanceTimersByTime(5_000)
    expect(reads).toBe(before + 1)
    // Why an hour: the cap this replaced stopped after a minute and left the wait stuck.
    vi.advanceTimersByTime(3_600_000)
    expect(reads).toBeGreaterThan(before + 1)
    screen = null
    vi.advanceTimersByTime(5_000)
    expect(published.at(-1)?.payload.state).toBe('working')
  })

  it('keeps watching a wait row it inherited from a restored store', () => {
    // Why: a hydrated wait has no hook behind it to end it, so the loop must adopt it.
    current = {
      ...row('working'),
      hookEventName: 'screen_prompt',
      payload: { state: 'waiting', prompt: 'run gh pr diff', agentType: 'copilot' }
    }
    screen = null
    const loop = corroboration()
    loop.arm(current)
    vi.advanceTimersByTime(1_000)
    expect(published.at(-1)?.payload.state).toBe('working')
  })

  it('drops every pending read on teardown', () => {
    const loop = corroboration()
    loop.arm(current)
    loop.clearAll()
    vi.advanceTimersByTime(10_000)
    expect(reads).toBe(0)
  })
})
