import {
  isScreenPromptForRow,
  needsScreenPromptCorroboration,
  type ScreenPromptObservation
} from '../../../shared/agent-screen-prompt'
import { CodexSubagentPollScheduler } from '../../../shared/codex-subagent-poll-scheduler'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import type { EnrichedAgentHookEventPayload } from './server-types'

/**
 * Why deferred: the hook that asks for permission is posted before the dialog is painted, so a read
 * taken while the row is being stored would find the agent's previous screen. A quarter second is
 * long enough for the TUI to paint the dialog and short enough that a person has not yet answered.
 */
export const SCREEN_PROMPT_CORROBORATION_DELAY_MS = 250

/**
 * Why a re-read while our wait owns the pane: nothing tells Orca the dialog is gone. `PostToolUse`
 * fires when the approved command FINISHES, so a ten-minute command would read Needs You for ten
 * minutes, and answering a dialog emits no hook of its own.
 */
export const SCREEN_PROMPT_RECHECK_MS = 1_000

/** After this many one-second reads the loop slows to this, so an unanswered dialog is still watched
 *  without paying a read per second for the rest of the session. */
export const SCREEN_PROMPT_SLOW_RECHECK_MS = 5_000
export const SCREEN_PROMPT_FAST_RECHECK_COUNT = 10
const SCREEN_PROMPT_PAINT_RETRIES_MS = [250, 750, 1_500, 3_000, 6_000]
/** A pane that reconnects answers inside this; one that never binds again would otherwise hold a
 *  Needs You row for the life of the process. */
const SCREEN_PROMPT_UNREADABLE_RECHECK_LIMIT = 20

/** Fields this server stamps per row; carrying them into a repaint would claim a fresh observation. */
function withoutRowTiming(row: EnrichedAgentHookEventPayload): AgentHookEventPayload {
  const {
    receivedAt: _receivedAt,
    evidenceObservedAt: _evidenceObservedAt,
    stateStartedAt: _stateStartedAt,
    turnStartedAt: _turnStartedAt,
    observation: _observation,
    isReplay: _isReplay,
    programStatus: _programStatus,
    programStatusOnly: _programStatusOnly,
    authorityRestartId: _authorityRestartId,
    ...keep
  } = row
  return keep
}

/** The row the screen's dialog implies, or null when the screen does not prove one for this row. */
export function screenPromptRow(
  armed: EnrichedAgentHookEventPayload,
  current: EnrichedAgentHookEventPayload | undefined,
  screen: ScreenPromptObservation | null
): AgentHookEventPayload | null {
  // Why the row identity: any later hook event is fresher evidence than a screen read, and the
  // screen may be holding a dialog for a turn that a later row already moved past.
  if (!current || current.receivedAt !== armed.receivedAt) {
    return null
  }
  if (!needsScreenPromptCorroboration(current.payload) || !isScreenPromptForRow(current, screen)) {
    return null
  }
  // Why built from the row: the resume identity, launch token and turn counters on it are what
  // readers join on, and a row assembled from scratch would drop them (#10630).
  return {
    ...withoutRowTiming(current),
    hookEventName: 'screen_prompt',
    payload: { ...current.payload, state: 'waiting' }
  }
}

/** The row that ends a screen-observed wait once the dialog is gone. */
export function screenPromptReleaseRow(
  working: EnrichedAgentHookEventPayload
): AgentHookEventPayload {
  return {
    ...withoutRowTiming(working),
    hookEventName: 'screen_prompt_cleared',
    payload: { ...working.payload, state: 'working' }
  }
}

export type ScreenPromptCorroborationHost = {
  /** False where no pane screen is readable at all (the relay's parser, a headless peer). */
  readsScreen: () => boolean
  /** `undefined` when the pane's screen cannot be read at all, which is not "no dialog".
   *  `agentType` picks the screen evidence appropriate for the agent. */
  readScreenPrompt: (
    paneKey: string,
    agentType: string | undefined
  ) => ScreenPromptObservation | null | undefined
  /** Drops the pane's own screen clock without another read: the wait it justified has ended, and
   *  a stamp carried into the next dialog would predate that dialog's own turn. This trades the
   *  inverse risk - an answered dialog left painted across a turn boundary is stamped fresh - for
   *  never letting a stale stamp outlive the wait it was earned by. */
  forgetScreenPrompt?: (paneKey: string) => void
  currentRow: (paneKey: string) => EnrichedAgentHookEventPayload | undefined
  /** Publishes the repaint and returns the `receivedAt` the stored row ended up with. */
  publishScreenPromptRow: (row: AgentHookEventPayload) => number | undefined
}

type PanePrompt = {
  /** The row the screen displaced. Restoring it is how the wait ends without a hook event. */
  working: EnrichedAgentHookEventPayload
  /** Set once our waiting row is the pane's; until then the pane still shows the hook's row. */
  waitingReceivedAt?: number
  rechecks: number
  retryPaint?: boolean
  /** Consecutive reads that could not see the pane at all; bounded so a dead pane's wait ends. */
  unreadableRechecks?: number
}

/**
 * Why local panes only: a paired client must not repaint a row the execution host owns, and a remote
 * pane's own host parses its bytes (`terminal-title-observation.ts` skips remote Claude evidence the
 * same way).
 */
function isCorroboratableRow(row: EnrichedAgentHookEventPayload): boolean {
  return row.connectionId === null && needsScreenPromptCorroboration(row.payload)
}

/** One deferred screen read per pane, then a re-read while the wait it published stands.
 *  A firing re-reads the pane, so a wakeup left behind by a closed pane is a no-op. */
export class ScreenPromptCorroboration {
  private readonly panes = new Map<string, PanePrompt>()
  private readonly reads = new CodexSubagentPollScheduler<string>(
    SCREEN_PROMPT_CORROBORATION_DELAY_MS,
    (paneKey) => {
      this.onDue(paneKey)
    }
  )

  constructor(private readonly host: ScreenPromptCorroborationHost) {}

  /** Call for every stored row: only a claim the screen can settle is worth a read. */
  arm(row: EnrichedAgentHookEventPayload): void {
    const pane = this.panes.get(row.paneKey)
    // Why follow our own repaint: the store restates a row (refreshTerminalStatusEvidence) under a
    // new clock, and the loop that ends this wait must keep tracking which row is ours.
    if (row.hookEventName === 'screen_prompt') {
      if (!this.host.readsScreen() || row.connectionId !== null) {
        this.forget(row.paneKey)
        return
      }
      if (pane) {
        pane.waitingReceivedAt = row.receivedAt
        return
      }
      // Why seed: a hydrated wait row comes back with nothing watching it, and no hook is coming to
      // end a wait whose dialog closed while Orca was away.
      this.panes.set(row.paneKey, {
        working: row,
        waitingReceivedAt: row.receivedAt,
        rechecks: 0
      })
      this.scheduleRecheck(row.paneKey)
      return
    }
    if (!this.host.readsScreen() || !isCorroboratableRow(row)) {
      // Why gated: this branch runs for every stored row, and a stamp is only owed to a live loop or
      // a copilot row -- a remote pane owns none, so it pays no lookup.
      const ownsStamp =
        row.connectionId === null && (pane !== undefined || row.payload.agentType === 'copilot')
      this.forget(row.paneKey, ownsStamp)
      return
    }
    this.panes.set(row.paneKey, {
      working: row,
      rechecks: 0,
      retryPaint:
        row.payload.agentType === 'copilot' &&
        (row.hookEventName === 'PermissionRequest' || row.hookEventName === 'permissionRequest')
    })
    this.reads.schedule(row.paneKey, row.paneKey, SCREEN_PROMPT_CORROBORATION_DELAY_MS)
  }

  /** The pane's screen just gained a dialog, which is earlier evidence than any timer would have. */
  noteDialogGained(paneKey: string): void {
    const current = this.host.currentRow(paneKey)
    if (!current || !this.host.readsScreen() || !isCorroboratableRow(current)) {
      return
    }
    // Why an existing loop is left alone: it is already reading this pane, and restarting it here
    // would lose the release that ends the wait. A stored wait row never reaches this point -
    // `isCorroboratableRow` reads `working` - so this only guards a second report mid-read.
    const pending = this.panes.get(paneKey)
    if (pending) {
      if (current.payload.agentType === 'copilot') {
        pending.retryPaint = true
      }
      return
    }
    this.panes.set(paneKey, {
      working: current,
      rechecks: 0,
      retryPaint: current.payload.agentType === 'copilot'
    })
    this.reads.schedule(paneKey, paneKey, SCREEN_PROMPT_CORROBORATION_DELAY_MS)
  }

  clearAll(): void {
    this.panes.clear()
    this.reads.clearAll()
  }

  private onDue(paneKey: string): void {
    const pane = this.panes.get(paneKey)
    const current = this.host.currentRow(paneKey)
    if (!pane || !current) {
      this.forget(paneKey)
      return
    }
    if (pane.waitingReceivedAt === undefined) {
      this.corroborate(paneKey)
      return
    }
    // Why the guard: any hook event after our repaint is fresher authority than a screen read.
    if (
      current.receivedAt !== pane.waitingReceivedAt ||
      current.hookEventName !== 'screen_prompt'
    ) {
      this.forget(paneKey)
      return
    }
    const reading = this.host.readScreenPrompt(paneKey, current.payload.agentType)
    // Why wait: a pane whose terminal is not bound yet (a restored one still reconnecting) cannot
    // answer, and releasing on that would report a live Working over a dialog nobody looked at.
    if (reading === undefined) {
      pane.unreadableRechecks = (pane.unreadableRechecks ?? 0) + 1
      if (pane.unreadableRechecks <= SCREEN_PROMPT_UNREADABLE_RECHECK_LIMIT) {
        this.scheduleRecheck(paneKey)
        return
      }
      this.forget(paneKey)
      this.host.publishScreenPromptRow(screenPromptReleaseRow(pane.working))
      return
    }
    pane.unreadableRechecks = 0
    if (isScreenPromptForRow(pane.working, reading)) {
      this.scheduleRecheck(paneKey)
      return
    }
    // Why forget first: forgetting after the publish would cancel the read that publish's own arm()
    // just scheduled for this pane.
    this.forget(paneKey)
    this.host.publishScreenPromptRow(screenPromptReleaseRow(pane.working))
  }

  private corroborate(paneKey: string): void {
    const pane = this.panes.get(paneKey)
    const current = this.host.currentRow(paneKey)
    if (!pane || !current) {
      this.forget(paneKey)
      return
    }
    const reading = this.host.readScreenPrompt(paneKey, current.payload.agentType)
    const next = reading === undefined ? null : screenPromptRow(pane.working, current, reading)
    if (!next) {
      const delay = SCREEN_PROMPT_PAINT_RETRIES_MS[pane.rechecks]
      if (
        pane.retryPaint &&
        current.receivedAt === pane.working.receivedAt &&
        delay !== undefined
      ) {
        pane.rechecks += 1
        this.reads.schedule(paneKey, paneKey, delay)
      } else {
        this.forget(paneKey)
      }
      return
    }
    pane.waitingReceivedAt = this.host.publishScreenPromptRow(next) ?? 0
    pane.rechecks = 0
    this.scheduleRecheck(paneKey)
  }

  private scheduleRecheck(paneKey: string): void {
    const pane = this.panes.get(paneKey)
    if (!pane) {
      return
    }
    pane.rechecks += 1
    // Why slow rather than stop: nothing else ends an unanswered dialog's wait, and its answer emits
    // no hook at all - the next one is the approved command's PostToolUse, minutes later.
    const delay =
      pane.rechecks > SCREEN_PROMPT_FAST_RECHECK_COUNT
        ? SCREEN_PROMPT_SLOW_RECHECK_MS
        : SCREEN_PROMPT_RECHECK_MS
    this.reads.schedule(paneKey, paneKey, delay)
  }

  private forget(paneKey: string, dropStamp = true): void {
    this.panes.delete(paneKey)
    this.reads.clear(paneKey)
    if (dropStamp) {
      this.host.forgetScreenPrompt?.(paneKey)
    }
  }
}
