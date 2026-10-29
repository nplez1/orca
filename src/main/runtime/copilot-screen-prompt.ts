import {
  isScreenInteractivePromptReason,
  type ScreenPromptObservation
} from '../../shared/agent-screen-prompt'
import { detectTerminalWaitBlockedReason } from './terminal-wait-detection'

const MAX_TRACKED_PROMPTS = 512

export class CopilotScreenPromptGained {
  private readonly sinceByPtyId = new Map<string, number>()

  observe(
    ptyId: string,
    lines: readonly string[],
    now = Date.now()
  ): ScreenPromptObservation | null {
    const reason = detectTerminalWaitBlockedReason(lines.join('\n'))
    if (!reason || !isScreenInteractivePromptReason(reason)) {
      this.forget(ptyId)
      return null
    }
    const since = this.sinceByPtyId.get(ptyId) ?? now
    if (!this.sinceByPtyId.has(ptyId) && this.sinceByPtyId.size >= MAX_TRACKED_PROMPTS) {
      const oldest = this.sinceByPtyId.keys().next().value
      if (oldest !== undefined) {
        this.sinceByPtyId.delete(oldest)
      }
    }
    this.sinceByPtyId.set(ptyId, since)
    return { reason, since }
  }

  /** Drops a pane's stamp without reading its grid - the wait it justified is over, so the next
   *  dialog on this pane must be stamped from its own first sighting. */
  forget(ptyId: string): void {
    this.sinceByPtyId.delete(ptyId)
  }
}
