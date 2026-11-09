import {
  isScreenInteractivePromptReason,
  type ScreenPromptObservation
} from '../../../../shared/agent-screen-prompt'
import { OrcaRuntimeWithAgentPromptRequestCorrelation } from '../input/orca-runtime-agent-prompt-request-correlation'
import { detectTerminalWaitBlockedReason } from './terminal-wait-detection'
import { getPiStateTitleStatus } from '../../../../shared/agent-status/title/providers/pi-state-title-marker'
import { PiAskDialogScreenGained } from '../../pi-ask-dialog-screen'
import { CopilotScreenPromptGained } from '../../copilot-screen-prompt'

/** What a pane's screen says about a dialog holding it, for the hook store to corroborate a row
 *  whose agent cannot report one itself. Split out of the prompt-submission chain only to keep that
 *  file inside its line budget. */
export abstract class OrcaRuntimeWithPaneScreenPrompt extends OrcaRuntimeWithAgentPromptRequestCorrelation {
  /** The pane's own first-seen clock for a pi card; see PiAskDialogScreenGained. */
  private readonly piAskDialogs = new PiAskDialogScreenGained()
  private readonly copilotDialogs = new CopilotScreenPromptGained()

  /** The interactive dialog the pane's screen is holding, `null` when it holds none the blocked-text
   *  layer reads as a person being asked something, and `undefined` when there is no terminal to ask:
   *  a restored pane reconnects after the hook store starts, and "cannot see it" is not "no dialog". */
  readPaneScreenPrompt(
    paneKey: string,
    agentType: string | undefined
  ): ScreenPromptObservation | null | undefined {
    const handle = this.getAgentStatusTerminalHandleForPaneKey(paneKey)
    if (!handle) {
      return undefined
    }
    if (agentType === 'pi') {
      return this.readPiAskDialogPrompt(handle)
    }
    if (agentType === 'copilot') {
      try {
        const ptyId = this.getTerminalAgentStatusPtyId(handle)
        const screen = this.readCaughtUpRuledScreen(ptyId)
        return screen ? this.copilotDialogs.observe(ptyId, screen.lines) : undefined
      } catch {
        return undefined
      }
    }
    try {
      const snapshot = this.getTerminalAgentStatusSnapshot(
        handle,
        this.getTerminalAgentStatusPtyId(handle)
      )
      const reason = detectTerminalWaitBlockedReason(snapshot.waitText)
      if (!reason || !isScreenInteractivePromptReason(reason)) {
        return null
      }
      // Why the stamp: a dialog the tail gained before this turn opened is an answered one that has
      // not scrolled away yet, and the reader's own decision discards it on this clock.
      return { reason, since: snapshot.waitBlockedAt ?? 0 }
    } catch {
      // Why unverifiable rather than "no dialog": these readers throw once a terminal is gone or its
      // handle is stale, and answering "none" there would end a wait on evidence nobody read.
      return undefined
    }
  }

  /** Drops the pane's screen-evidence clock; see CopilotScreenPromptGained.forget. Pi's own title
   *  check withdraws its stamp on every read, so only the agent without one needs this. */
  forgetPaneScreenPrompt(paneKey: string): void {
    try {
      const handle = this.getAgentStatusTerminalHandleForPaneKey(paneKey)
      if (!handle) {
        return
      }
      this.copilotDialogs.forget(this.getTerminalAgentStatusPtyId(handle))
    } catch {
      // Why swallowed: this runs inside the store's commit path for every stored row, so a stale
      // handle here must not stop the row it arrived with from being committed.
    }
  }

  /** Why the title as well as the grid: pi prints its own card footer when it narrates about one, so
   *  the footer alone would read a transcript line as a dialog. `π !` is pi's own claim, painted by
   *  the titlebar extension for exactly as long as a dialog holds the pane and never for scrollback.
   *  Why the marker decides and the grid only dates it: the footer vocabulary is measured against
   *  one card build at a time, and every wording pi had not painted yet read "no card" - while a
   *  hold is not a rescue, because the row this lane exists for already reads `working` and stays
   *  there for as long as the card stands (#227, and again when Pi-Bolt changed its footers).
   *  Why `current`: the pane's own marker outranks the gained stamp - a card the pane still claims
   *  cannot be scrollback, and the store must not reject it on a turn clock it could not pin. */
  private readPiAskDialogPrompt(handle: string): ScreenPromptObservation | null | undefined {
    try {
      const ptyId = this.getTerminalAgentStatusPtyId(handle)
      const snapshot = this.getTerminalAgentStatusSnapshot(handle, ptyId)
      if (getPiStateTitleStatus(snapshot.title ?? '') !== 'permission') {
        this.piAskDialogs.forget(ptyId)
        return null
      }
      const screen = this.readRuledScreen(ptyId)
      const lines = screen ? screen.lines : this.readLiveTerminalScreenLines(ptyId)
      const card = this.piAskDialogs.observe(ptyId, lines)
      if (card) {
        return { ...card, current: true }
      }
      // Why the alternate screen is the second witness: pi paints a card there and leaves it when the
      // card closes, which is what separates a dialog whose footer this reader has never measured
      // from a marker that has not caught up with its own close - an answered card, or a pi killed
      // with one up. The marker alone would start a wait on a pane already back at its prompt, and a
      // wait the pane never earned is #136 in miniature.
      if (screen && !screen.alternateScreen) {
        return undefined
      }
      // No grid to read the mode from (a pane whose size the runtime does not know yet): the marker
      // is the only witness there is.
      return { ...this.piAskDialogs.observeClaim(ptyId), current: true }
    } catch {
      return undefined
    }
  }

  /** Whether the pane's own title still claims a dialog is open. The one question that separates a
   *  pane this reader is blind to from a pane that holds no dialog at all: pi's `π !` is its own
   *  claim, painted for exactly as long as a dialog or a startup prompt holds the pane. */
  paneClaimsDialog(paneKey: string, agentType: string | undefined): boolean {
    if (agentType !== 'pi') {
      return false
    }
    try {
      const handle = this.getAgentStatusTerminalHandleForPaneKey(paneKey)
      if (!handle) {
        return false
      }
      const snapshot = this.getTerminalAgentStatusSnapshot(
        handle,
        this.getTerminalAgentStatusPtyId(handle)
      )
      return getPiStateTitleStatus(snapshot.title ?? '') === 'permission'
    } catch {
      return false
    }
  }

  /** The tail gained a dialog this pane must answer: tell the store now rather than wait its timer,
   *  which is the only way a dialog painted long after the agent's last hook is ever noticed. */
  notePaneScreenPromptGained(paneKey: string): void {
    this.onPaneScreenPromptGained?.(paneKey)
  }
}
