import { resolveAgentSessionStartedAt } from '../../../../shared/agent-session-start-time'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import {
  withMirroredEvidenceReceipt,
  agentStatusAuthorityObservedAt
} from '../../../../shared/agent-status-freshness'
import { agentEntryCompletionAt } from '../../../../shared/agent-completion-time'
import { agentMainAgentVerdict } from '../../../../shared/agent-main-agent-verdict'
import { normalizeCompatibleAgentStatusEntryForOwner } from '../../../../shared/agent-title-owner'
import {
  isWebTerminalSurfaceTabId,
  toWebTerminalSurfaceTabId
} from '../../../../shared/terminal-surface-id'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type {
  MirroredTerminalTab,
  TerminalSurface,
  WebSessionTabsBatchContext,
  WebSessionTabsSyncState
} from './state'
import {
  isClientOwnedAgentStatus,
  isMirroredAgentStatusOwnedBy,
  clientAgentStatusFencesHost,
  hostAgentStatusPiercesClientAuthority,
  isMirroredAgentPaneKeyForTabs,
  batchAgentPaneKeysForTabs,
  remapHostAgentStatus,
  updateBatchAgentPaneKey
} from './agent-status-primitives'
import {
  agentStatusEntryEqual,
  isAgentStatusFresh,
  isMirroredCommandCodeTurnBump,
  writableWebSessionTabsRecord
} from './state-equality-core'

/** Host dialog observations already granted the fence, per mirrored pane. A republish of the same
 *  observation is not new evidence; see the `hostDialogIsNew` guard in the patch builder. */
const lastHostDialogObservationByPaneKey = new Map<string, number>()

/** Bounded the way the authority registries are: a pane that dies with a dialog up never reports a
 *  clear, and a pane key is never reused. */
const MAX_TRACKED_HOST_DIALOGS = 512

function noteHostDialogObservation(paneKey: string, observation: number): void {
  if (
    !lastHostDialogObservationByPaneKey.has(paneKey) &&
    lastHostDialogObservationByPaneKey.size >= MAX_TRACKED_HOST_DIALOGS
  ) {
    const oldest = lastHostDialogObservationByPaneKey.keys().next().value
    if (oldest !== undefined) {
      lastHostDialogObservationByPaneKey.delete(oldest)
    }
  }
  lastHostDialogObservationByPaneKey.set(paneKey, observation)
}

export function resetHostDialogObservationsForTests(): void {
  lastHostDialogObservationByPaneKey.clear()
}

export function buildMirroredAgentStatusPatch(
  state: WebSessionTabsSyncState,
  currentTerminalTabs: readonly TerminalTab[],
  terminalSurfaceTabs: readonly TerminalSurface[],
  mirroredTerminalTabs: readonly MirroredTerminalTab[],
  environmentId: string,
  worktreeId: string,
  retractedTabIds: ReadonlySet<string>,
  now: number,
  batchContext?: WebSessionTabsBatchContext
): Pick<WebSessionTabsSyncState, 'agentStatusByPaneKey' | 'agentStatusEpoch' | 'sortEpoch'> | null {
  const mirroredTabIds = new Set<string>()
  for (const tab of currentTerminalTabs) {
    if (isWebTerminalSurfaceTabId(tab.id)) {
      mirroredTabIds.add(tab.id)
    }
  }
  for (const surface of terminalSurfaceTabs) {
    mirroredTabIds.add(toWebTerminalSurfaceTabId(surface.parentTabId))
  }

  if (mirroredTabIds.size === 0) {
    return null
  }

  let retainedSurfaceByHostTabAndPrunedLeafId:
    | Map<string, ReadonlyMap<string, TerminalSurface>>
    | undefined
  for (const entry of mirroredTerminalTabs) {
    if (entry.retainedSurfaceByPrunedLeafId) {
      retainedSurfaceByHostTabAndPrunedLeafId ??= new Map()
      retainedSurfaceByHostTabAndPrunedLeafId.set(
        entry.hostTabId,
        entry.retainedSurfaceByPrunedLeafId
      )
    }
  }
  const nextByPaneKey = new Map<string, AgentStatusEntry>()
  for (const surface of terminalSurfaceTabs) {
    const retainedSurface = retainedSurfaceByHostTabAndPrunedLeafId
      ?.get(surface.parentTabId)
      ?.get(surface.leafId)
    const hostEntry = remapHostAgentStatus(surface, retainedSurface)
    if (!hostEntry) {
      continue
    }
    const existing =
      nextByPaneKey.get(hostEntry.paneKey) ?? state.agentStatusByPaneKey[hostEntry.paneKey]
    const entry = withMirroredEvidenceReceipt(
      {
        ...hostEntry,
        ...(hostEntry.connectionId === undefined ? { connectionId: environmentId } : {}),
        // Why: the sweep keys on worktreeId, so a host projection that omits it (the synthetic
        // done, an idle title) left a row no snapshot could retire — it outlived the agent until
        // the store reset on restart. Stamp the mirror's own worktree, as connectionId is stamped.
        ...(hostEntry.worktreeId === undefined ? { worktreeId } : {})
      },
      existing,
      now
    )
    // Retain fresher OSC state while remapping authoritative host identity.
    const hostIdentityPredatesCurrentTurn =
      existing !== undefined &&
      entry.state === 'done' &&
      existing.state !== 'done' &&
      existing.stateStartedAt > entry.stateStartedAt
    // Why: cross-machine wall clocks are not comparable, so the host frame could
    // outrank live client status forever; a proven client writer keeps its own
    // state (still adopting the host's identity fields below) unless the host
    // carries a state class the client's bytes can never see.
    const hostPiercesFence = hostAgentStatusPiercesClientAuthority(entry)
    // Why: a row the host mirrored here IS the host's statement, so the fence has nothing left to
    // protect — the host's next frame, including the release of a wait it opened, must land. Without
    // this the fenced branch re-spread the host's own `waiting` over the host's `working`/`done`,
    // and only the client's next byte write (or the 30-minute stale boundary) released a dialog that
    // had already been answered.
    const existingIsHostRow = existing?.mirroredEvidenceReceivedAt !== undefined
    // Why the observation and not the frame: a host that republishes a row it already sent is not
    // new evidence, and re-piercing on it would reopen a wait the client's bytes have since moved
    // past — a host dying with a dialog open would pin the client on Needs You for good, since every
    // unrelated republish carries that frozen row. Only a wait the host is still observing anew wins.
    const hostObservation = hostPiercesFence ? agentStatusAuthorityObservedAt(entry) : undefined
    const hostDialogIsNew =
      hostObservation !== lastHostDialogObservationByPaneKey.get(entry.paneKey)
    // Why outright rather than on a clock comparison: pi re-posts `ui_prompt_active` on every tool
    // event while the dialog is open, so a wait that loses once and wins once more IS the
    // working/waiting oscillation this fence exists to stop — and `updatedAt` is the client's clock
    // against the host's, which skew alone can invert.
    const hostDialogOutranksClient = hostPiercesFence && !existingIsHostRow && hostDialogIsNew
    if (hostObservation !== undefined) {
      noteHostDialogObservation(entry.paneKey, hostObservation)
    }
    const clientOwnsEntry =
      !existingIsHostRow && clientAgentStatusFencesHost(entry.paneKey, existing, entry, now)
    const nextEntry =
      existing &&
      !hostDialogOutranksClient &&
      // Why the fallback is not gated on the fence: a republished dialog pierces, and gating here
      // handed it the win on every republish — the stale-wait pin this fence exists to prevent. A
      // genuinely new dialog already wins through `hostDialogOutranksClient` above.
      (clientOwnsEntry ||
        (isAgentStatusFresh(existing, now) && existing.updatedAt > entry.updatedAt))
        ? {
            ...normalizeCompatibleAgentStatusEntryForOwner(existing, entry.agentType),
            ...(clientOwnsEntry && existing.state === 'working' && entry.state === 'working'
              ? { workingMode: entry.workingMode }
              : {}),
            paneKey: entry.paneKey,
            worktreeId: entry.worktreeId ?? existing.worktreeId,
            tabId: entry.tabId,
            providerSession:
              existing.providerSession ??
              (hostIdentityPredatesCurrentTurn ? undefined : entry.providerSession),
            // Only hooks mint message content and OSC blanks it; take host-first even behind the client fence (#12906), unlike providerSession.
            lastAssistantMessage:
              (hostIdentityPredatesCurrentTurn ? undefined : entry.lastAssistantMessage) ??
              existing.lastAssistantMessage,
            lastAssistantMessageIsToolOutput:
              hostIdentityPredatesCurrentTurn || entry.lastAssistantMessage === undefined
                ? existing.lastAssistantMessageIsToolOutput
                : entry.lastAssistantMessageIsToolOutput
          }
        : entry
    const accepted =
      nextEntry === entry ? entry : withHostProgramStatus(nextEntry, entry.programStatus)
    const retained = existing ? undefined : state.retainedAgentsByPaneKey?.[entry.paneKey]
    nextByPaneKey.set(entry.paneKey, {
      ...accepted,
      firstStateStartedAt: resolveAgentSessionStartedAt({
        entry: accepted,
        previous: existing ?? retained?.entry,
        previousStartedAt: retained?.startedAt
      })
    })
  }

  let nextAgentStatusByPaneKey = state.agentStatusByPaneKey
  let changed = false
  let aggregateRelevantChange = false
  let sortRelevantChange = false

  for (const paneKey of batchAgentPaneKeysForTabs(state, mirroredTabIds, batchContext)) {
    if (!isMirroredAgentPaneKeyForTabs(paneKey, mirroredTabIds)) {
      continue
    }
    if (
      !isMirroredAgentStatusOwnedBy(state.agentStatusByPaneKey[paneKey], environmentId, worktreeId)
    ) {
      continue
    }
    // The retirement sweep must see the live row to suppress ghost retention.
    if (isMirroredAgentPaneKeyForTabs(paneKey, retractedTabIds)) {
      continue
    }
    if (nextByPaneKey.has(paneKey)) {
      continue
    }
    // Host omission cannot prove OSC-driven exit. Retain owned rows through staleness so wake decays them like local panes instead of erasing them (STA-3107).
    if (isClientOwnedAgentStatus(paneKey, state.agentStatusByPaneKey[paneKey])) {
      continue
    }
    if (nextAgentStatusByPaneKey === state.agentStatusByPaneKey) {
      nextAgentStatusByPaneKey = writableWebSessionTabsRecord(
        state,
        'agentStatusByPaneKey',
        batchContext
      )
    }
    delete nextAgentStatusByPaneKey[paneKey]
    updateBatchAgentPaneKey(paneKey, false, batchContext)
    changed = true
    aggregateRelevantChange = true
    sortRelevantChange = true
  }

  for (const [paneKey, entry] of nextByPaneKey) {
    const existing = nextAgentStatusByPaneKey[paneKey]
    if (
      agentStatusEntryEqual(existing, entry) &&
      existing?.firstStateStartedAt === entry.firstStateStartedAt
    ) {
      continue
    }
    if (nextAgentStatusByPaneKey === state.agentStatusByPaneKey) {
      nextAgentStatusByPaneKey = writableWebSessionTabsRecord(
        state,
        'agentStatusByPaneKey',
        batchContext
      )
    }
    nextAgentStatusByPaneKey[paneKey] = entry
    updateBatchAgentPaneKey(paneKey, true, batchContext)
    changed = true
    const entryAttributionChanged =
      existing?.worktreeId !== entry.worktreeId || existing?.tabId !== entry.tabId
    const entryFreshnessChanged =
      !!existing && isAgentStatusFresh(existing, now) !== isAgentStatusFresh(entry, now)
    const doneAttentionChanged =
      existing?.state === 'done' &&
      entry.state === 'done' &&
      agentEntryCompletionAt(existing) !== agentEntryCompletionAt(entry)
    const workingModeChanged = existing?.workingMode !== entry.workingMode
    // A verdict moves no clock, including a main agent failing while its subagents keep the row working.
    const verdictChanged =
      !!existing && agentMainAgentVerdict(existing) !== agentMainAgentVerdict(entry)
    const entrySortRelevantChange =
      !existing ||
      existing.firstStateStartedAt !== entry.firstStateStartedAt ||
      existing.state !== entry.state ||
      !isAgentStatusFresh(existing, now) ||
      entryFreshnessChanged ||
      entryAttributionChanged ||
      doneAttentionChanged ||
      isMirroredCommandCodeTurnBump(existing, entry)
    aggregateRelevantChange =
      aggregateRelevantChange || entrySortRelevantChange || workingModeChanged || verdictChanged
    sortRelevantChange = sortRelevantChange || entrySortRelevantChange
  }

  if (!changed) {
    return null
  }

  return {
    agentStatusByPaneKey: nextAgentStatusByPaneKey,
    agentStatusEpoch: aggregateRelevantChange ? state.agentStatusEpoch + 1 : state.agentStatusEpoch,
    sortEpoch: sortRelevantChange ? state.sortEpoch + 1 : state.sortEpoch
  }
}

// Why host-only: client OSC writes have no facet channel, so the host's facet is the current one.
function withHostProgramStatus(
  entry: AgentStatusEntry,
  programStatus: AgentStatusEntry['programStatus']
): AgentStatusEntry {
  const { programStatus: _clientFacet, ...rest } = entry
  return programStatus ? { ...rest, programStatus } : rest
}
