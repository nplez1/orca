import type { RuntimeTerminalWaitBlockedReason } from './runtime-terminal-contracts'

/** A dialog the pane's screen is holding, as the blocked-text layer read it. */
export type ScreenPromptObservation = {
  reason: RuntimeTerminalWaitBlockedReason
  /** When the tail gained this wording. Older than the turn means it is not this turn's wait. */
  since: number
  /** The pane's own live marker says this dialog is open right now: pi's `π !` title, painted for as
   *  long as a dialog holds the pane and never for scrollback. Set only by a reader that checked the
   *  marker, and it outranks `since` - a card the pane itself still claims cannot be scrollback, and
   *  a turn whose start the store could not pin would otherwise reject a live wait. */
  current?: boolean
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
 * Why Pi too: pi *does* report a dialog (`ui_prompt_start`), and that claim is only as durable as
 * pi's silence. Any post that arrives while the card sits unanswered replaces the wait - a reload's
 * `agent_start`, a child agent settling, a stamp that lost the extension's prompt depth - and no
 * later event restores it until the card closes. Measured on this repo's own store: a question open
 * from 08:44:04 to 09:02:10 held a `waiting` row for 3m31s and then read `working` for the remaining
 * 14m35s. Like Copilot's, pi's card is the witness, but it is painted inside the alternate screen
 * with cursor addressing, so it reaches the rendered grid and never the tail text that lane reads
 * (Pi-Bolt 1.0.0 `ask_user_question`, 100x30 PTY). Hence its own grid read and its own gained stamp.
 */
function screenReportsAgentDialogs(agentType: string | undefined): boolean {
  return agentType === 'copilot' || agentType === 'pi'
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
    (screen.current === true || screen.since >= (row.turnStartedAt ?? row.receivedAt))
  )
}
