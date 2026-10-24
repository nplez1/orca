import {
  isScreenInteractivePromptReason,
  type ScreenPromptObservation
} from '../../../../shared/agent-screen-prompt'
import { OrcaRuntimeWithAgentPromptRequestCorrelation } from '../../orca-runtime-agent-prompt-request-correlation'
import { detectTerminalWaitBlockedReason } from '../../terminal-wait-detection'
import { getPiStateTitleStatus } from '../../../../shared/pi-state-title-marker'
import { PiAskDialogScreenGained } from '../../pi-ask-dialog-screen'

/** What a pane's screen says about a dialog holding it, for the hook store to corroborate a row
 *  whose agent cannot report one itself. Split out of the prompt-submission chain only to keep that
 *  file inside its line budget. */
export abstract class OrcaRuntimeWithPaneScreenPrompt extends OrcaRuntimeWithAgentPromptRequestCorrelation {
  /** The pane's own first-seen clock for a pi card; see PiAskDialogScreenGained. */
  private readonly piAskDialogs = new PiAskDialogScreenGained()

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

  /** Why the title as well as the grid: pi prints its own card footer when it narrates about one, so
   *  the footer alone would read a transcript line as a dialog. `π !` is pi's own claim, painted by
   *  the titlebar extension for exactly as long as a dialog holds the pane and never for scrollback.
   *  Why the ruled grid first: it refuses a grid painted for another size (a resize, a reflow, a
   *  provider-restored suffix), and holding the wait is right there - releasing on a garbled grid
   *  would flap the row. The live projection is the fallback for a pane whose size the runtime does
   *  not know yet (a restored pane reconnecting), which is also the only case where the ruled grid is
   *  unavailable but the card is still readable; a mis-read there costs one tick, because the release
   *  row re-arms this same read.
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
      return card ? { ...card, current: true } : card
    } catch {
      return undefined
    }
  }

  /** The tail gained a dialog this pane must answer: tell the store now rather than wait its timer,
   *  which is the only way a dialog painted long after the agent's last hook is ever noticed. */
  notePaneScreenPromptGained(paneKey: string): void {
    this.onPaneScreenPromptGained?.(paneKey)
  }
}
