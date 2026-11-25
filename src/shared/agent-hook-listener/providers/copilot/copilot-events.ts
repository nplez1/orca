import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../../agent-status/contracts/agent-status-types'
import {
  consumeCopilotBackgroundShells,
  consumeCopilotSubagent,
  createCopilotBackgroundWorkState,
  endCopilotSubagent,
  pendingCopilotBackgroundWork,
  readBackgroundAgentId,
  readCopilotAgentNotificationAgentId,
  readCopilotShellCompletionShellId,
  readEndedAgentIdFromReadAgent,
  readStartedShellId,
  readTerminatedShellIds,
  reengageCopilotBackgroundAgents,
  registerCopilotBackgroundAgent,
  registerCopilotBackgroundShell,
  startCopilotSubagent,
  type CopilotBackgroundWorkState
} from '../../copilot-background-work-state'
import { readFirstString } from '../../interactive-tool'
import type { HookListenerState } from '../../listener-state'
import { resolvePrompt, resolveToolState } from '../../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../../provider-event-routing'
import {
  isCopilotAgentLaunchResultTool,
  isCopilotBackgroundShellLaunch,
  isCopilotBackgroundSubagentLaunch,
  isCopilotBackgroundWorkCompletionNotification,
  readCopilotShellDescription,
  readCopilotToolName,
  readCopilotToolResultText,
  readCopilotWriteAgentTargets
} from './copilot-background-signals'
import {
  isAskUserTool,
  normalizeCopilotEventName,
  resolveCopilotEventName
} from './copilot-tool-fields'

function readCopilotSessionId(hookPayload: Record<string, unknown>): string | undefined {
  return readFirstString(hookPayload, ['session_id', 'sessionId'])
}

/** A subagent's own turn/tool events arrive on the LEAD pane carrying the subagent's session id
 *  (only its permission events carry the lead's), so attributing them to the pane overwrote the
 *  lead's prompt/tool caches and let the child's `Stop` mark the lead done. */
function isCopilotChildSessionEvent(
  state: HookListenerState,
  paneKey: string,
  normalizedEventName: unknown,
  hookPayload: Record<string, unknown>
): boolean {
  // Why: SessionStart always belongs to the lead and (re)adopts its id.
  if (normalizedEventName === 'SessionStart') {
    return false
  }
  const sessionId = readCopilotSessionId(hookPayload)
  if (!sessionId) {
    return false
  }
  const leadSessionId = state.lastToolByPaneKey.get(paneKey)?.leadSessionId
  return leadSessionId !== undefined && sessionId !== leadSessionId
}

function isCopilotStopHookActive(hookPayload: Record<string, unknown>): boolean {
  return hookPayload.stop_hook_active === true || hookPayload.stopHookActive === true
}

function getCopilotBackgroundWorkState(
  state: HookListenerState,
  paneKey: string
): CopilotBackgroundWorkState | undefined {
  return state.copilotBackgroundWorkByPaneKey.get(paneKey)
}

// Why: PermissionRequest precedes approval, and its fire-and-forget permission_prompt can also
// fire for auto-approved requests; only elicitation_dialog reliably means the user is blocked.
export function normalizeCopilotEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  const normalizedEventName = normalizeCopilotEventName(
    resolveCopilotEventName(eventName, hookPayload)
  )
  const notificationType = readFirstString(hookPayload, ['notification_type', 'notificationType'])
  // Why: a child subagent's own turn/tool events must not touch the pane's caches, but its
  // background launches must still be tracked (below), so classify it here and return at the end.
  const isChildSessionEvent = isCopilotChildSessionEvent(
    state,
    paneKey,
    normalizedEventName,
    hookPayload
  )
  const isBlockingNotification =
    normalizedEventName === 'Notification' && notificationType === 'elicitation_dialog'
  const toolSnapshot = extractToolFields('copilot', normalizedEventName, hookPayload)
  const postToolResultText =
    normalizedEventName === 'PostToolUse' ? readCopilotToolResultText(hookPayload) : undefined
  // Why: register only when the result proves the shell was actually backgrounded. An async shell
  // that finishes within `initial_wait` returns its output directly and would otherwise be tracked
  // as pending forever (no `shell_completed` notification ever comes for it).
  const startedShellId =
    normalizedEventName === 'PostToolUse' && isCopilotBackgroundShellLaunch(hookPayload)
      ? readStartedShellId(postToolResultText)
      : undefined
  // Why: an agent that reads a shell to completion with `read_bash` gets the completion in the tool
  // result and Copilot then suppresses `shell_completed`; without this the shell would stay pending.
  const terminatedShellIds = readTerminatedShellIds(postToolResultText)
  // Why: the launch result names the agent whatever tool or mode started it, so its ends match it
  // by id and a duplicate report cannot end another agent.
  const toolName = readCopilotToolName(hookPayload)
  const backgroundAgentId = isCopilotAgentLaunchResultTool(toolName)
    ? readBackgroundAgentId(postToolResultText)
    : undefined
  const readAgentEndedId =
    toolName?.toLowerCase() === 'read_agent'
      ? readEndedAgentIdFromReadAgent(postToolResultText)
      : undefined
  const reengagedAgentIds =
    normalizedEventName === 'PostToolUse' ? readCopilotWriteAgentTargets(hookPayload) : []
  const endedAgentIds = state.copilotEndedAgentIdsByPaneKey.get(paneKey) ?? new Set<string>()
  const subagentToolStarted =
    normalizedEventName === 'PreToolUse' && isCopilotBackgroundSubagentLaunch(hookPayload)
  // Why: a background task launch that fails (e.g. the task tool rejects a missing agent name) never
  // starts anything, so nothing will ever complete it; consume the entry the PreToolUse added or the
  // pane stays working for the rest of the session.
  const failedBackgroundLaunch =
    normalizedEventName === 'PostToolUseFailure' && isCopilotBackgroundSubagentLaunch(hookPayload)
  const completionShellId = readCopilotShellCompletionShellId(hookPayload)
  const backgroundWorkCompletion = isCopilotBackgroundWorkCompletionNotification(
    normalizedEventName,
    notificationType
  )
  const stopHookActive = isCopilotStopHookActive(hookPayload)
  // Why: a child subagent's own async/detached shell is still this pane's background work and must
  // be tracked, but the child's turn events must not resume the lead's stopped turn.
  const preserveLeadStopped = (previous: CopilotBackgroundWorkState | undefined): boolean =>
    isChildSessionEvent ? (previous?.leadStopped ?? false) : false

  const storeBackgroundWork = (work: CopilotBackgroundWorkState): void => {
    if (pendingCopilotBackgroundWork(work) === 0) {
      state.copilotBackgroundWorkByPaneKey.delete(paneKey)
    } else {
      state.copilotBackgroundWorkByPaneKey.set(paneKey, work)
    }
  }

  let backgroundWorkState = getCopilotBackgroundWorkState(state, paneKey)
  if (normalizedEventName === 'SessionStart') {
    state.copilotBackgroundWorkByPaneKey.delete(paneKey)
    endedAgentIds.clear()
    backgroundWorkState = undefined
  } else if (startedShellId) {
    backgroundWorkState = {
      ...registerCopilotBackgroundShell(backgroundWorkState ?? createCopilotBackgroundWorkState(), {
        description: readCopilotShellDescription(hookPayload) ?? '',
        shellId: startedShellId
      }),
      leadStopped: preserveLeadStopped(backgroundWorkState)
    }
    state.copilotBackgroundWorkByPaneKey.set(paneKey, backgroundWorkState)
  } else if (terminatedShellIds.length > 0 && backgroundWorkState) {
    // Why: a lead tool result that ends background work is the lead working again, not a settle;
    // a child's read of the pane's last shell must preserve the lead's stopped flag.
    const leadStopped = preserveLeadStopped(backgroundWorkState)
    backgroundWorkState = {
      ...consumeCopilotBackgroundShells(backgroundWorkState, terminatedShellIds),
      leadStopped
    }
    storeBackgroundWork(backgroundWorkState)
  } else if (backgroundAgentId || readAgentEndedId || reengagedAgentIds.length > 0) {
    let next = backgroundWorkState ?? createCopilotBackgroundWorkState()
    if (backgroundAgentId) {
      next = registerCopilotBackgroundAgent(next, backgroundAgentId, endedAgentIds)
    }
    if (readAgentEndedId) {
      next = endCopilotSubagent(next, readAgentEndedId, endedAgentIds, 'none')
    }
    next = reengageCopilotBackgroundAgents(next, reengagedAgentIds, endedAgentIds)
    backgroundWorkState = { ...next, leadStopped: preserveLeadStopped(backgroundWorkState) }
    storeBackgroundWork(backgroundWorkState)
  } else if (subagentToolStarted) {
    const base = backgroundWorkState ?? createCopilotBackgroundWorkState()
    backgroundWorkState = {
      ...base,
      pendingUnidentifiedSubagentCount: base.pendingUnidentifiedSubagentCount + 1,
      leadStopped: preserveLeadStopped(backgroundWorkState)
    }
    state.copilotBackgroundWorkByPaneKey.set(paneKey, backgroundWorkState)
  } else if (normalizedEventName === 'SubagentStart') {
    backgroundWorkState = startCopilotSubagent(
      backgroundWorkState ?? createCopilotBackgroundWorkState()
    )
    state.copilotBackgroundWorkByPaneKey.set(paneKey, backgroundWorkState)
  } else if (failedBackgroundLaunch && backgroundWorkState) {
    const leadStopped = preserveLeadStopped(backgroundWorkState)
    backgroundWorkState = {
      ...consumeCopilotSubagent(backgroundWorkState, { includeRoster: false }),
      leadStopped
    }
    storeBackgroundWork(backgroundWorkState)
  } else if (
    !isChildSessionEvent &&
    backgroundWorkState &&
    (normalizedEventName === 'UserPromptSubmit' ||
      normalizedEventName === 'PreToolUse' ||
      normalizedEventName === 'PostToolUse' ||
      normalizedEventName === 'PostToolUseFailure' ||
      normalizedEventName === 'PermissionRequest')
  ) {
    backgroundWorkState = {
      ...backgroundWorkState,
      leadStopped: false
    }
    state.copilotBackgroundWorkByPaneKey.set(paneKey, backgroundWorkState)
  } else if (backgroundWorkCompletion && backgroundWorkState) {
    // Why: a detached shell reports `shell_detached_completed`, an async one `shell_completed`; a
    // completion is matched to the shell it names, so an unknown one cannot consume a different
    // pending shell and settle the pane early. An agent end is matched to the agent it names; an
    // id-less `agent_idle` ends nothing, since its turn's `SubagentStop` may already have.
    const agentId = readCopilotAgentNotificationAgentId(hookPayload)
    backgroundWorkState =
      backgroundWorkCompletion === 'shell'
        ? consumeCopilotBackgroundShells(
            backgroundWorkState,
            completionShellId ? [completionShellId] : []
          )
        : endCopilotSubagent(
            backgroundWorkState,
            agentId,
            endedAgentIds,
            agentId
              ? 'counts'
              : notificationType === 'agent_completed'
                ? 'counts-or-roster'
                : 'none'
          )
    storeBackgroundWork(backgroundWorkState)
  } else if (normalizedEventName === 'SubagentStop' && backgroundWorkState) {
    backgroundWorkState = endCopilotSubagent(
      backgroundWorkState,
      readFirstString(hookPayload, ['agent_id', 'agentId']),
      endedAgentIds,
      'counts'
    )
    storeBackgroundWork(backgroundWorkState)
  }
  if (endedAgentIds.size > 0) {
    state.copilotEndedAgentIdsByPaneKey.set(paneKey, endedAgentIds)
  } else {
    state.copilotEndedAgentIdsByPaneKey.delete(paneKey)
  }

  // Why: everything below describes the LEAD turn; a child's own event only contributed background
  // work above and must not relabel the row, reset its prompt/tool caches, or settle it.
  if (isChildSessionEvent) {
    return null
  }

  const isAskUserPrompt =
    (normalizedEventName === 'PreToolUse' || normalizedEventName === 'PermissionRequest') &&
    isAskUserTool(toolSnapshot.toolName)
  const stopWaitsForBackgroundWork =
    normalizedEventName === 'Stop' &&
    !stopHookActive &&
    backgroundWorkState !== undefined &&
    pendingCopilotBackgroundWork(backgroundWorkState) > 0
  if (normalizedEventName === 'Stop' && backgroundWorkState) {
    backgroundWorkState = {
      ...backgroundWorkState,
      leadStopped: stopWaitsForBackgroundWork
    }
    state.copilotBackgroundWorkByPaneKey.set(paneKey, backgroundWorkState)
  }
  const completedLastBackgroundWork =
    (backgroundWorkCompletion !== undefined || normalizedEventName === 'SubagentStop') &&
    backgroundWorkState !== undefined &&
    pendingCopilotBackgroundWork(backgroundWorkState) === 0 &&
    backgroundWorkState.leadStopped
  const stateName =
    normalizedEventName === 'SessionStart' ||
    normalizedEventName === 'UserPromptSubmit' ||
    normalizedEventName === 'PostToolUse' ||
    normalizedEventName === 'PostToolUseFailure'
      ? 'working'
      : isBlockingNotification || isAskUserPrompt
        ? 'blocked'
        : normalizedEventName === 'PreToolUse' || normalizedEventName === 'PermissionRequest'
          ? 'working'
          : stopWaitsForBackgroundWork || (normalizedEventName === 'Stop' && stopHookActive)
            ? 'working'
            : completedLastBackgroundWork ||
                normalizedEventName === 'Stop' ||
                normalizedEventName === 'SessionEnd'
              ? 'done'
              : normalizedEventName === 'ErrorOccurred'
                ? hookPayload.recoverable === true
                  ? 'working'
                  : 'done'
                : null

  if (!stateName) {
    return null
  }

  const snapshot = resolveToolState(state, paneKey, toolSnapshot, {
    resetOnNewTurn: isNewTurnEvent('copilot', normalizedEventName)
  })

  const effectivePrompt = normalizedEventName === 'Notification' ? '' : promptText

  return normalizeAgentStatusPayload({
    state: stateName,
    prompt: resolvePrompt(state, paneKey, effectivePrompt, {
      resetOnNewTurn: isNewTurnEvent('copilot', normalizedEventName)
    }),
    agentType: 'copilot',
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    interactivePrompt: snapshot.interactivePrompt,
    lastAssistantMessage: snapshot.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: snapshot.lastAssistantMessageIsToolOutput
  })
}
