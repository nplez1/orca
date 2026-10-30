import { retainOpenCodeWriterTopology } from './cli-writer-observation'
import { buildSpoolHookBody, type SpoolRecord } from '../../../shared/agent-hook-spool'
import { checkHookOwnerPresence } from '../../../shared/agent-hook-owner-presence'
import { normalizeHookPayload } from '../../../shared/agent-hook-listener'
import { isAgentHookSource, type AgentHookSource } from '../../../shared/agent-hook-relay'
import {
  bindOpenCodeTuiSession,
  isOpenCodeSharedServerPost
} from '../../../shared/agent-hook-listener/opencode-session-registry'
import type { NormalizedLocalHook } from './server-types'
import { AgentHookServerTmuxStatus } from './server-tmux-status'
import { getClaudeObservedConfigDirs } from '../../claude-accounts/claude-profile-installed-router'

/** The row's arrival stamp, when this process still holds a row for the pane. */
export function statusRowReceivedAt(row: unknown): number | undefined {
  if (!row || typeof row !== 'object' || !('receivedAt' in row)) {
    return undefined
  }
  return typeof row.receivedAt === 'number' ? row.receivedAt : undefined
}

/**
 * Whether a replay drained while hooks are live is newer than the row the pane held when the drain
 * started.
 *
 * Why the drain-start watermark and not the live row: applying a replay stamps its own row, so a
 * drain of two records for one pane would drop the second one — and a `Stop` spooled right behind a
 * prompt is exactly the pair a brief stall produces. Within one drain the per-pane file is in write
 * order, so only the pre-drain state has to be compared against.
 *
 * Why this is a rule and not an inline comparison: the spool stamp is whole seconds, so a record
 * written alongside a live arrival looks older than it is. Treating that as stale costs one replay,
 * bounded by the next event; applying it would move the pane backwards.
 */
export function spoolReplayIsNewer(
  record: SpoolRecord,
  rowReceivedAt: number | undefined
): boolean {
  return rowReceivedAt === undefined || record.receivedAt > rowReceivedAt
}

export abstract class AgentHookServerIngestNormalization extends AgentHookServerTmuxStatus {
  protected setClaudeBackgroundEvidence(
    paneKey: string,
    hasRunningTask: boolean,
    hasActiveCron: boolean
  ): void {
    if (hasRunningTask) {
      this.state.claudeRunningNonAgentTaskPaneKeys.add(paneKey)
    } else {
      this.state.claudeRunningNonAgentTaskPaneKeys.delete(paneKey)
    }
    if (hasActiveCron) {
      this.state.claudeActiveSessionCronPaneKeys.add(paneKey)
    } else {
      this.state.claudeActiveSessionCronPaneKeys.delete(paneKey)
    }
  }

  protected normalizeLocalHookPayload(
    source: AgentHookSource,
    body: unknown,
    isReplay = false
  ): NormalizedLocalHook {
    if (source !== 'claude' || typeof body !== 'object' || body === null) {
      const event = normalizeHookPayload(this.state, source, body, this.env, {
        admitOpenCodeTui: (identity) => {
          const disposition = this.getAgentStatusDisposition(identity.paneKey, {
            ...identity,
            source,
            isReplay
          })
          if (disposition === 'restart') {
            this.observations.rebind(identity.paneKey)
          }
          return disposition !== 'suppress'
        }
      })
      retainOpenCodeWriterTopology(event, source, body)
      if (
        event &&
        event.hookEventName === 'SessionStart' &&
        isOpenCodeSharedServerPost(source, body)
      ) {
        this.kickOpenCodeBinder()
      }
      return {
        event,
        onAccepted: () =>
          bindOpenCodeTuiSession(this.state, source, body, event?.providerSession?.id)
      }
    }
    const rawPaneKey = (body as Record<string, unknown>).paneKey
    const paneKey = typeof rawPaneKey === 'string' ? rawPaneKey.trim() : ''
    if (!paneKey) {
      return { event: normalizeHookPayload(this.state, source, body, this.env) }
    }
    const previousRunningTask = this.state.claudeRunningNonAgentTaskPaneKeys.has(paneKey)
    const previousActiveCron = this.state.claudeActiveSessionCronPaneKeys.has(paneKey)
    const event = normalizeHookPayload(this.state, source, body, this.env)
    const transcriptPath = event?.providerSession?.transcriptPath
    if (transcriptPath) {
      // A wrapper's CLAUDE_CONFIG_DIR is only visible here; History scans it too (#23505).
      getClaudeObservedConfigDirs()?.observeTranscriptPath(transcriptPath)
    }
    const nextRunningTask = this.state.claudeRunningNonAgentTaskPaneKeys.has(paneKey)
    const nextActiveCron = this.state.claudeActiveSessionCronPaneKeys.has(paneKey)
    this.setClaudeBackgroundEvidence(paneKey, previousRunningTask, previousActiveCron)
    if (!event || event.paneKey !== paneKey) {
      return { event }
    }
    // Nested CLIs inherit pane keys; rejected status must not change the owner's background-work gate.
    return {
      event,
      onAccepted: () => this.setClaudeBackgroundEvidence(paneKey, nextRunningTask, nextActiveCron)
    }
  }

  // Spool records are durable replay evidence, not a live observation.
  protected ingestSpoolRecord(record: SpoolRecord): Promise<void> | void {
    if (!isAgentHookSource(record.source)) {
      return
    }
    const token = this.token
    const statusHookGeneration = this.statusHookGeneration
    const apply = () => {
      if (
        !this.statusHooksEnabled ||
        this.token !== token ||
        this.statusHookGeneration !== statusHookGeneration
      ) {
        throw new Error('Status hook spool replay interrupted')
      }
      this.applySpoolHook(record, body)
    }
    const body = this.normalizeHookBodyPaneKeyAlias(buildSpoolHookBody(record))
    const pending = checkHookOwnerPresence(this.state, record.source, body, this.env, (paneKey) =>
      this.checkAgentPresence(paneKey)
    )
    return pending ? pending.then(apply) : apply()
  }

  private applySpoolHook(record: SpoolRecord, body: unknown): void {
    if (!isAgentHookSource(record.source)) {
      return
    }
    const normalized = this.normalizeLocalHookPayload(record.source, body, true)
    if (!normalized.event) {
      return
    }
    const exit = this.agentExitedAtByPaneKey.get(this.resolvePaneKeyAlias(normalized.event.paneKey))
    // Whole-second spool timestamps prove pre-exit ownership only with a full second of separation.
    if (exit && record.receivedAt + 1000 <= exit.at) {
      return
    }
    // Why only on the timer drain (the record says so): the startup replay runs before the listener
    // binds, so every spooled record predates any live event and the exit-second rule above already
    // settles it. A drain that runs while hooks are live must not apply a record the pane has already
    // moved past — a timed-out prompt that a later Stop superseded would otherwise flip the pane back
    // to "working". The watermark is the row stamp the drain captured before it applied anything.
    if (record.requireNewerThanRow === true) {
      const watermark =
        typeof record.replayRowReceivedAt === 'number' ? record.replayRowReceivedAt : undefined
      if (!spoolReplayIsNewer(record, watermark)) {
        return
      }
    }
    const replay = { ...normalized.event, isReplay: true as const }
    const statusDisposition = this.getAgentStatusDisposition(replay.paneKey, {
      source: record.source,
      hookEventName: replay.hookEventName,
      isReplay: true,
      hasExplicitPrompt: replay.hasExplicitPrompt,
      launchToken: replay.launchToken
    })
    if (statusDisposition === 'suppress') {
      return
    }
    const event = statusDisposition === 'restart' ? { ...replay, launchToken: undefined } : replay
    if (statusDisposition === 'restart') {
      this.observations.rebind(event.paneKey)
    }
    this.recordCurrentAuthorityObservation(event)
    this.applyNormalizedStatus(event, normalized.onAccepted)
    if (event.payload.state !== 'done') {
      this.withdrawReplayObservation(this.resolvePaneKeyAlias(event.paneKey))
    }
  }
}
