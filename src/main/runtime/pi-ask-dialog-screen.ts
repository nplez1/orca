import type { ScreenPromptObservation } from '../../shared/agent-screen-prompt'

/** Pi's own card footer, on one line, when a select/question card holds the pane.
 *
 *  Measured against Pi-Bolt 1.0.0 `ask_user_question` in a 100x30 PTY: the card repaints inside the
 *  alternate screen, so this wording reaches the rendered grid and never the accumulated tail — the
 *  reason the tail-text lane reads no dialog for pi at all. Both halves are required on the same
 *  line so a transcript line quoting pi's footer is not a card.
 *
 *  The `ctx.ui.*` half is pi-tui's own selector, which is what a permission gate, a plan review and
 *  the project-trust prompt paint: `↑↓ navigate  enter select  escape/ctrl+c cancel`. */
const PI_CARD_ACCEPT_ANCHORS = [
  'enter to select',
  'space to toggle',
  'enter select',
  'enter submit'
] as const
const PI_CARD_CANCEL_ANCHORS = [
  'esc to cancel',
  'ctrl+c to cancel',
  'escape/ctrl+c cancel'
] as const
/** A collapsed card keeps its cancel half but drops the accept half; the expand affordance is itself
 *  the witness that a card is holding the pane. */
const PI_CARD_COLLAPSED_ANCHORS = ['ctrl+] to expand'] as const
/** A footer clipped by pane width ends in an ellipsis: the cancel half was cut off, not omitted. */
const PI_CARD_TRUNCATION_SUFFIX = '…'

/** Bounds the panes a card can be remembered for; see the cap in `observe`. */
const PI_CARD_STAMP_LIMIT = 512

/** Whether a rendered grid line is pi's card footer. */
function isPiCardFooterLine(line: string): boolean {
  const normalized = line.toLowerCase()
  const hasAccept = PI_CARD_ACCEPT_ANCHORS.some((anchor) => normalized.includes(anchor))
  const hasCancel = PI_CARD_CANCEL_ANCHORS.some((anchor) => normalized.includes(anchor))
  if (hasAccept && hasCancel) {
    return true
  }
  if (PI_CARD_COLLAPSED_ANCHORS.some((anchor) => normalized.includes(anchor)) && hasCancel) {
    return true
  }
  return hasAccept && normalized.trimEnd().endsWith(PI_CARD_TRUNCATION_SUFFIX)
}

/** Whether the pane's rendered grid is holding a pi card a person has to answer. */
export function showsPiAskDialogScreen(lines: readonly string[]): boolean {
  return lines.some(isPiCardFooterLine)
}

/**
 * When each pane's grid first gained a pi card.
 *
 * Why its own clock: the wait a card implies has to be argued against the row that claims the pane is
 * working, and that row is often *newer* than the card - pi keeps posting (`agent_start` after a
 * reload, a child ending, a model stamp) while the card sits unanswered, and every one of those posts
 * replaces the `waiting` row the card earned. When the card appeared is therefore the stamp that says
 * "this dialog predates the claim that the pane is working".
 *
 * Why absence clears: a card that leaves the grid was answered, cancelled, or scrolled away, and a
 * wait must never outlive the dialog that justified it.
 */
export class PiAskDialogScreenGained {
  private readonly sinceByPtyId = new Map<string, number>()

  /** The card the pane's grid holds, `null` when it holds none, and `undefined` when the grid could
   *  not be read — "cannot see it" is not "no dialog", and only the caller knows which to believe. */
  observe(
    ptyId: string,
    lines: readonly string[] | null,
    now = Date.now()
  ): ScreenPromptObservation | null | undefined {
    if (lines === null) {
      return undefined
    }
    if (!showsPiAskDialogScreen(lines)) {
      this.forget(ptyId)
      return null
    }
    const since = this.sinceByPtyId.get(ptyId) ?? now
    // Why the cap: a pane killed with its card up never reports a clear, and a pty id is never
    // reused, so without one the map grows by a number per pane for the life of the process.
    if (!this.sinceByPtyId.has(ptyId) && this.sinceByPtyId.size >= PI_CARD_STAMP_LIMIT) {
      const oldest = this.sinceByPtyId.keys().next().value
      if (oldest !== undefined) {
        this.sinceByPtyId.delete(oldest)
      }
    }
    this.sinceByPtyId.set(ptyId, since)
    return { reason: 'agent-interactive-prompt', since }
  }

  /** Drops a pane's stamp without reading its grid - the pane's own title withdrew the claim. */
  forget(ptyId: string): void {
    this.sinceByPtyId.delete(ptyId)
  }
}
