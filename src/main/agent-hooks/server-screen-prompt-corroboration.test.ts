import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentHookSource } from '../../shared/agent-hook-relay'
import { AgentHookServer, _internals } from './server'
import {
  SCREEN_PROMPT_FAST_RECHECK_COUNT,
  SCREEN_PROMPT_SLOW_RECHECK_MS,
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

function piRow(
  overrides: Partial<EnrichedAgentHookEventPayload> = {}
): EnrichedAgentHookEventPayload {
  return row('working', {
    source: 'pi',
    payload: { state: 'working', prompt: 'fix the summary pane', agentType: 'pi' },
    ...overrides
  })
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

  it('repaints a pi row that landed under a card older than the row', () => {
    // Why the currency flag: pi's own title marker says the card is open now, which outranks any
    // gained stamp - including a turn start the store could not pin.
    const armed = piRow({ receivedAt: 2_000, turnStartedAt: undefined })
    const next = screenPromptRow(armed, armed, {
      reason: 'agent-interactive-prompt',
      since: 1_200,
      current: true
    })
    expect(next?.payload.state).toBe('waiting')
    expect(next?.hookEventName).toBe('screen_prompt')
  })

  it('still discards an observation that claims no currency and predates the turn', () => {
    // Why: only a reader that checked the pane's own marker may set `current`; a bare screen read
    // stays held to the turn clock, the way Copilot's necessarily is.
    const armed = piRow({ turnStartedAt: 1_300 })
    expect(
      screenPromptRow(armed, armed, { reason: 'agent-interactive-prompt', since: 1_200 })
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
  let screen: { reason: 'agent-approval-prompt'; since: number } | null | undefined

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

  it('holds a wait when the wired reader cannot see the pane', async () => {
    let reading: 'prompt' | 'unreadable' | 'clear' = 'prompt'
    let reads = 0
    server.setScreenPromptReader(() => {
      reads += 1
      if (reading === 'unreadable') {
        return undefined
      }
      return reading === 'prompt' ? { reason: 'agent-approval-prompt', since: Date.now() } : null
    })
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'run a command' })
    await post({ hook_event_name: 'PermissionRequest', tool_name: 'bash' })
    await vi.waitFor(() => expect(states()).toEqual(['waiting']), { timeout: 4_000 })
    reading = 'unreadable'
    const before = reads
    await vi.waitFor(() => expect(reads).toBeGreaterThan(before), { timeout: 4_000 })
    expect(states()).toEqual(['waiting'])
    reading = 'clear'
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
    // Why bind after start: the headless host starts the store before it has a runtime to read with.
    await restarted.start({ env: 'production', userDataPath })
    restarted.setScreenPromptReader(() => null)
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
  let screen: { reason: 'agent-approval-prompt'; since: number } | null | undefined
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

  function corroboration(forgotten: string[] = []) {
    const loop = new ScreenPromptCorroboration({
      readsScreen: () => true,
      readScreenPrompt: () => {
        reads += 1
        return screen
      },
      forgetScreenPrompt: (paneKey) => forgotten.push(paneKey),
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

  it('retries a permission request whose dialog paints after the first read', () => {
    current = row('working', { hookEventName: 'PermissionRequest' })
    screen = null
    const loop = corroboration()
    loop.arm(current)
    vi.advanceTimersByTime(250)
    expect(reads).toBe(1)
    expect(published).toHaveLength(0)
    screen = { reason: 'agent-approval-prompt', since: 1_200 }
    vi.advanceTimersByTime(250)
    expect(published.at(-1)?.payload.state).toBe('waiting')
  })

  it('stops retrying an automatically approved request', () => {
    current = row('working', { hookEventName: 'permissionRequest' })
    screen = null
    const loop = corroboration()
    loop.arm(current)
    vi.advanceTimersByTime(30_000)
    expect(reads).toBe(6)
    expect(published).toHaveLength(0)
    vi.advanceTimersByTime(30_000)
    expect(reads).toBe(6)
  })

  it('stops retrying once a newer row replaces the one it armed', () => {
    current = row('working', { hookEventName: 'PermissionRequest' })
    screen = null
    const loop = corroboration()
    loop.arm(current)
    vi.advanceTimersByTime(500)
    expect(reads).toBe(2)
    // Not re-armed: the ladder itself must notice the row it was armed for is gone.
    current = row('working', { receivedAt: 2_000 })
    vi.advanceTimersByTime(30_000)
    // One read sees the newer row and stops there; without the guard the ladder runs to six.
    expect(reads).toBe(3)
    expect(published).toHaveLength(0)
  })

  it('stops holding a wait on a pane that never becomes readable', () => {
    const loop = corroboration()
    loop.arm(current)
    vi.advanceTimersByTime(250)
    expect(published.at(-1)?.payload.state).toBe('waiting')
    screen = undefined
    vi.advanceTimersByTime(200_000)
    expect(published.at(-1)?.payload.state).toBe('working')
    const settled = reads
    vi.advanceTimersByTime(200_000)
    expect(reads).toBe(settled)
  })

  it('keeps a wait when unreadable reads are interrupted by a readable one', () => {
    const loop = corroboration()
    loop.arm(current)
    vi.advanceTimersByTime(250)
    expect(published.at(-1)?.payload.state).toBe('waiting')
    screen = undefined
    vi.advanceTimersByTime(15_000)
    // The dialog is still up; one readable screen restarts the count of consecutive misses.
    screen = { reason: 'agent-approval-prompt', since: 1_200 }
    vi.advanceTimersByTime(6_000)
    screen = undefined
    vi.advanceTimersByTime(60_000)
    expect(published.some((row) => row.payload.state === 'working')).toBe(false)
  })

  it('defers the gained read so the dialog can paint first', () => {
    const loop = corroboration()
    loop.noteDialogGained(PANE)
    expect(reads).toBe(0)
    vi.advanceTimersByTime(249)
    expect(reads).toBe(0)
    vi.advanceTimersByTime(1)
    expect(reads).toBe(1)
  })

  it('drops the pane screen clock once a newer row ends the wait', () => {
    const forgotten: string[] = []
    const loop = corroboration(forgotten)
    loop.arm(current)
    vi.advanceTimersByTime(250)
    expect(published.at(-1)?.payload.state).toBe('waiting')
    expect(forgotten).toEqual([])
    current = row('done', { receivedAt: 2_000 })
    loop.arm(current)
    expect(forgotten).toEqual([PANE])
  })

  it('drops the stamp when a non-copilot row ends a live wait', () => {
    const forgotten: string[] = []
    const loop = corroboration(forgotten)
    loop.arm(current)
    vi.advanceTimersByTime(250)
    expect(published.at(-1)?.payload.state).toBe('waiting')
    // Why: clearing the loop also cancels the recheck, so nothing else can drop the stamp the wait
    // was justified by -- whoever ends the wait has to drop it, whatever agent their row names.
    loop.arm(
      row('done', {
        receivedAt: 2_000,
        payload: { state: 'done', prompt: 'review the diff', agentType: 'claude' }
      })
    )
    expect(forgotten).toEqual([PANE])
  })

  it('drops a pane stamp only for the agent that keeps one', () => {
    const forgotten: string[] = []
    const loop = corroboration(forgotten)
    // Why done rows: they are not corroboratable, so they take the branch that runs for every stored
    // row -- the one that must not pay a handle lookup for an agent that keeps no stamp.
    loop.arm(
      row('done', {
        receivedAt: 2_000,
        payload: { state: 'done', prompt: 'review the diff', agentType: 'claude' }
      })
    )
    expect(forgotten).toEqual([])
    loop.arm(row('done', { receivedAt: 3_000 }))
    expect(forgotten).toEqual([PANE])
  })

  it('never reads a row another host owns', () => {
    const forgotten: string[] = []
    current = row('working', { connectionId: 'conn-1' })
    const loop = corroboration(forgotten)
    loop.arm(current)
    vi.advanceTimersByTime(10_000)
    expect(reads).toBe(0)
    expect(published).toHaveLength(0)
    // A remote pane owns no local stamp, so ending its row costs no lookup either.
    expect(forgotten).toEqual([])
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

  it('keeps the wait while the pane cannot be read at all', () => {
    const loop = corroboration()
    loop.arm(current)
    vi.advanceTimersByTime(250)
    expect(published.map((entry) => entry.payload.state)).toEqual(['waiting'])
    // Why: a restored pane reconnects after the store starts, and "no terminal to ask" is not
    // "the dialog is gone".
    screen = undefined
    vi.advanceTimersByTime(3_000)
    expect(published.map((entry) => entry.payload.state)).toEqual(['waiting'])
    screen = null
    vi.advanceTimersByTime(1_000)
    expect(published.at(-1)?.payload.state).toBe('working')
  })

  it('keeps rechecking a pane whose first read could not see the dialog', () => {
    // Why: expanding a collapsed card, widening a narrow pane and a settled resize all make the
    // card readable again, and one blind read used to forget the pane for the rest of the question
    // — nothing re-reads a forgotten pane until the agent posts, which an unanswered card may
    // never do (#228).
    screen = undefined
    const loop = corroboration()
    loop.arm(current)
    vi.advanceTimersByTime(250)
    expect(reads).toBe(1)
    expect(published).toHaveLength(0)

    screen = { reason: 'agent-approval-prompt', since: 1_200 }
    vi.advanceTimersByTime(1_000)
    expect(published.map((entry) => entry.payload.state)).toEqual(['waiting'])
  })

  it('stops reading a pane whose screen never becomes readable', () => {
    // Why a bound: a restored row whose terminal never reconnects would otherwise be re-read every
    // 5 s for the life of the process. The release path already bounds itself this way.
    screen = undefined
    const loop = corroboration()
    loop.arm(current)
    vi.advanceTimersByTime(200_000)
    const settled = reads
    vi.advanceTimersByTime(200_000)
    expect(reads).toBe(settled)
    expect(published).toHaveLength(0)
  })

  it('forgets the pane once a hook row proves no dialog is holding it', () => {
    screen = undefined
    const loop = corroboration()
    loop.arm(current)
    vi.advanceTimersByTime(250)
    // A fresh row that needs no corroboration ends the loop: the blind read must not outlive it.
    current = { ...row('done'), receivedAt: current.receivedAt + 5 }
    loop.arm(current)
    const after = reads
    vi.advanceTimersByTime(SCREEN_PROMPT_SLOW_RECHECK_MS * 4)
    expect(reads).toBe(after)
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

describe('a Pi card the store only learns about from the screen', () => {
  let userDataPath: string
  let server: AgentHookServer
  let card: { reason: 'agent-interactive-prompt'; since: number } | null
  let askedTypes: (string | undefined)[]

  beforeEach(async () => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-pi-screen-prompt-'))
    card = null
    askedTypes = []
    server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    // Why the agent gate: the reader has two lanes and only the pi one can see a pi card. This fails
    // as a false negative if the store stops passing the row's agent type through.
    server.setScreenPromptReader((paneKey, agentType) => {
      askedTypes.push(agentType)
      return paneKey === PANE && agentType === 'pi' && card
        ? { ...card, current: true, since: Date.now() }
        : null
    })
  })

  afterEach(() => {
    server.stop()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  function states(): string[] {
    return server.getStatusSnapshotForPane(PANE).map((entry) => entry.state)
  }

  async function postPi(payload: Record<string, unknown>): Promise<void> {
    await postHookEvent(server, buildBody(payload), '/hook/pi')
  }

  it('repaints a working pi row while its card is up, and releases it when the card goes', async () => {
    card = { reason: 'agent-interactive-prompt', since: 0 }
    await postPi({ hook_event_name: 'before_agent_start', prompt: 'fix the summary pane' })
    await postPi({ hook_event_name: 'message_end', role: 'assistant', text: 'now the service' })
    await vi.waitFor(() => expect(states()).toEqual(['waiting']), { timeout: 4_000 })
    // Why the recorded argument: the wait above would pass for any lane if the reader ignored it.
    expect(askedTypes).toContain('pi')

    card = null
    await vi.waitFor(() => expect(states()).toEqual(['working']), { timeout: 4_000 })
  })

  it('re-asserts the wait after a later post overwrites it, which is the bug', async () => {
    card = { reason: 'agent-interactive-prompt', since: 0 }
    await postPi({ hook_event_name: 'before_agent_start', prompt: 'fix the summary pane' })
    await vi.waitFor(() => expect(states()).toEqual(['waiting']), { timeout: 4_000 })

    // Why this post: any pi event that lands under an unanswered card replaces the wait with
    // `working`, and before the screen lane nothing restored it until the card closed.
    await postPi({ hook_event_name: 'tool_execution_start', tool_name: 'read' })
    await vi.waitFor(() => expect(states()).toEqual(['waiting']), { timeout: 4_000 })
  })
})
