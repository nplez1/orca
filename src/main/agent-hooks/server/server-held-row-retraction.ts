import { admitLegacyAgentStatus } from '../../../shared/agent-hook-listener/listener-state'
import { AGENT_STATUS_2A_CURRENT_PRODUCER_MODE } from '../../../shared/agent-status/transport/agent-status-legacy-adapter'
import type { EnrichedAgentHookEventPayload } from './server-types'
import { AgentHookServerStatusApplication } from './server-status-application'

/** Retires a row the listener withdrew while normalizing a post.
 *
 * Its own link in the chain, and a fork-owned file, because the descendant lane retracts a held row
 * where no row can be published (#397) — so the deletion is performed and announced here, through
 * the path `dropStatusEntry` uses, rather than by the bare delete the listener could reach. */
export abstract class AgentHookServerHeldRowRetraction extends AgentHookServerStatusApplication {
  /** Retire the held row a retracted pane still has stored.
   *
   *  Only a row carrying descendants is the descendant lane's own; anything else is another lane's
   *  row, or the identity-only record a previous retirement left behind. */
  protected retractHeldStatusEntry(paneKey: string): void {
    const resolvedPaneKey = this.resolvePaneKeyAlias(paneKey)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Main admits enriched legacy rows; the shared view declares their base event type.
    const held = this.state.lastStatusByPaneKey.get(resolvedPaneKey) as
      | EnrichedAgentHookEventPayload
      | undefined
    if (!held || held.providerSessionOnly === true || (held.payload.subagents?.length ?? 0) === 0) {
      return
    }
    // A post a fence refuses must not retire the row its owner still holds.
    if (
      this.getAgentStatusDisposition(resolvedPaneKey, {
        source: held.source,
        launchToken: held.launchToken
      }) === 'suppress'
    ) {
      return
    }
    const deleted = this.deleteStatusEntry(resolvedPaneKey, { preserveAuthority: true })
    if (!deleted) {
      return
    }
    const resumeIdentity = this.toRetainedProviderSessionRow(deleted)
    const retained = resumeIdentity
      ? {
          ...resumeIdentity,
          // Why stripped: the child this hold named has left, and a retained record that still named
          // it would be retracted a second time by the next drain.
          payload: { ...resumeIdentity.payload, subagents: undefined, mainAgent: undefined }
        }
      : null
    if (retained) {
      admitLegacyAgentStatus(
        this.state,
        'main-status-cleanup',
        retained,
        AGENT_STATUS_2A_CURRENT_PRODUCER_MODE
      )
    }
    this.commitStatusRowMutation(deleted, retained)
    this.scheduleStatusPersist()
    this.notifyStatusChangeListeners()
    // Why the pane-clear and not a drop: the clear is the one that reaches the renderer, and the pane
    // this names keeps its PTY and its agent — only the row that was standing is gone.
    this.emitPaneStatusCleared({ paneKey: deleted.paneKey })
  }
}
