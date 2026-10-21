import type { RuntimeTerminalWaitBlockedReason } from './runtime-terminal-contracts'

/** A dialog the pane's screen is holding, as the blocked-text layer read it. */
export type ScreenPromptObservation = {
  reason: RuntimeTerminalWaitBlockedReason
  /** When the tail gained this wording. Older than the turn means it is not this turn's wait. */
  since: number
}

/** The blocked-text reasons that only match while a person is being asked something: an approval
 *  dialog or an ask-the-user question. Every other reason is a startup, trust or update prompt. */
export function isScreenInteractivePromptReason(reason: RuntimeTerminalWaitBlockedReason): boolean {
  return reason === 'agent-approval-prompt' || reason === 'agent-interactive-prompt'
}

/**
 * Agents whose own hook stream cannot be trusted to report that a dialog holds the pane.
 *
 * Copilot approves most requests itself, so `permission_prompt` is dropped as a wait signal and
 * `PermissionRequest` alone precedes both a prompt and a silent approval; the screen is the witness.
 *
 * Why Pi is NOT here, measured: a captured Pi select dialog (`pi --no-extensions -e <select ext>`,
 * 100x30, PTY recording) is painted with cursor addressing, so its footer never reaches the tail
 * text `detectTerminalWaitBlockedReason` reads - the visible grid has it, the tail does not. Reading
 * Pi's dialogs needs the emulated screen plus its own "gained" stamp, which is a separate change.
 */
function screenReportsAgentDialogs(agentType: string | undefined): boolean {
  return agentType === 'copilot'
}

/** Whether this row is a claim the screen can settle: the agent is working, and its hooks cannot
 *  say for it whether a question is on screen. A row that already reads `waiting`/`blocked` needs
 *  no corroboration. */
export function needsScreenPromptCorroboration(row: {
  agentType?: string
  state: string
}): boolean {
  return row.state === 'working' && screenReportsAgentDialogs(row.agentType)
}

/** Whether `screen` is a dialog this row is waiting on, painted during this row's turn. */
export function isScreenPromptForRow(
  row: { turnStartedAt?: number; receivedAt: number },
  screen: ScreenPromptObservation | null
): screen is ScreenPromptObservation {
  return (
    screen !== null &&
    isScreenInteractivePromptReason(screen.reason) &&
    screen.since >= (row.turnStartedAt ?? row.receivedAt)
  )
}
