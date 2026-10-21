import {
  isScreenInteractivePromptReason,
  type ScreenPromptObservation
} from '../../../../shared/agent-screen-prompt'
import { OrcaRuntimeWithAgentPromptRequestCorrelation } from '../../orca-runtime-agent-prompt-request-correlation'
import { detectTerminalWaitBlockedReason } from '../../terminal-wait-detection'

/** What a pane's screen says about a dialog holding it, for the hook store to corroborate a row
 *  whose agent cannot report one itself. Split out of the prompt-submission chain only to keep that
 *  file inside its line budget. */
export abstract class OrcaRuntimeWithPaneScreenPrompt extends OrcaRuntimeWithAgentPromptRequestCorrelation {
  /** The interactive dialog the pane's screen is holding, `null` when it holds none the blocked-text
   *  layer reads as a person being asked something, and `undefined` when there is no terminal to ask:
   *  a restored pane reconnects after the hook store starts, and "cannot see it" is not "no dialog". */
  readPaneScreenPrompt(paneKey: string): ScreenPromptObservation | null | undefined {
    const handle = this.getAgentStatusTerminalHandleForPaneKey(paneKey)
    if (!handle) {
      return undefined
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

  /** The tail gained a dialog this pane must answer: tell the store now rather than wait its timer,
   *  which is the only way a dialog painted long after the agent's last hook is ever noticed. */
  notePaneScreenPromptGained(paneKey: string): void {
    this.onPaneScreenPromptGained?.(paneKey)
  }
}
