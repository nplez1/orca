import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import {
  consumeCopilotBackgroundShells,
  consumeCopilotSubagent,
  createCopilotBackgroundWorkState,
  pendingCopilotBackgroundWork,
  readCopilotShellCompletionShellId,
  readStartedShellId,
  readTerminatedShellIds,
  registerCopilotBackgroundShell,
  type CopilotBackgroundWorkState
} from '../copilot-background-work-state'
import { extractToolResponseText, readFirstString } from '../interactive-tool'
import type { HookListenerState } from '../listener-state'
import { resolvePrompt, resolveToolState } from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'
import {
  isAskUserTool,
  normalizeCopilotEventName,
  readCopilotToolCall,
  readCopilotToolInput,
  resolveCopilotEventName
} from './copilot-tool-fields'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readCopilotToolName(hookPayload: Record<string, unknown>): string | undefined {
  const toolCall = readCopilotToolCall(hookPayload)
  return readFirstString(hookPayload, ['tool_name', 'toolName', 'name']) ?? toolCall.toolName
}

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

// Why: Copilot's shell tool starts background work with `mode: 'async'` (a shell readable via
// read_bash that reports `shell_completed`) or `detach: true` (a detached process reporting
// `shell_detached_completed`). There is no `background`/`runInBackground` field, so matching those
// names missed every real background shell.
function isCopilotBackgroundShellLaunch(hookPayload: Record<string, unknown>): boolean {
  const toolName = readCopilotToolName(hookPayload)
  if (toolName?.toLowerCase() !== 'bash' && toolName?.toLowerCase() !== 'powershell') {
    return false
  }
  const toolInput = readCopilotToolInput(hookPayload)
  return isRecord(toolInput) && (toolInput.mode === 'async' || toolInput.detach === true)
}

// Why: the `task` tool runs an agent in `sync` or `background` mode. Only background mode outlives
// the lead turn; a sync task completes with its PostToolUse, and counting it left the pane
// "Monitoring background tasks" for the rest of the session (the general-purpose agent emits no
// subagentStart/subagentStop, so nothing ever decremented it).
function isCopilotBackgroundSubagentLaunch(hookPayload: Record<string, unknown>): boolean {
  const toolName = readCopilotToolName(hookPayload)?.toLowerCase()
  if (toolName !== 'agent' && toolName !== 'task') {
    return false
  }
  const toolInput = readCopilotToolInput(hookPayload)
  return isRecord(toolInput) && toolInput.mode === 'background'
}

function isCopilotBackgroundWorkCompletionNotification(
  normalizedEventName: unknown,
  notificationType: string | undefined
): 'shell' | 'unidentified-subagent' | undefined {
  if (normalizedEventName !== 'Notification') {
    return undefined
  }
  if (notificationType === 'shell_completed' || notificationType === 'shell_detached_completed') {
    return 'shell'
  }
  if (notificationType === 'agent_completed') {
    return 'unidentified-subagent'
  }
  return undefined
}

function readCopilotShellDescription(hookPayload: Record<string, unknown>): string | undefined {
  const toolInput = readCopilotToolInput(hookPayload)
  return isRecord(toolInput) ? readFirstString(toolInput, ['description', 'command']) : undefined
}

function readCopilotToolResultText(hookPayload: Record<string, unknown>): string | undefined {
  return (
    extractToolResponseText(hookPayload.tool_result) ??
    extractToolResponseText(hookPayload.toolResult) ??
    extractToolResponseText(hookPayload.tool_response) ??
    extractToolResponseText(hookPayload.toolResponse)
  )
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

// Why: PermissionRequest fires before allow/ask/deny (stays working). The notification hook is
// supposed to fire only once a prompt is shown to the user (copilot-cli 1.0.26, copilot-cli#2586),
// but it is fire-and-forget and also fires for requests that auto-approve, so `permission_prompt`
// blocks only while the request is still in flight (see stalePermissionPromptNotification below).
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
  // Why: Copilot's notification hook is fire-and-forget, so a permission_prompt for a request that
  // resolves without the user (session/rule/`--yolo` auto-approval, copilot-cli#2586) can land after
  // the tool already ran and strand the pane `blocked` until the next turn. A completed tool is
  // positive evidence the prompt was never shown; an absent snapshot still blocks, so a real prompt
  // is never hidden.
  const stalePermissionPromptNotification =
    notificationType === 'permission_prompt' &&
    state.lastToolByPaneKey.get(paneKey)?.toolCompleted === true
  const isBlockingNotification =
    normalizedEventName === 'Notification' &&
    (notificationType === 'elicitation_dialog' ||
      (notificationType === 'permission_prompt' && !stalePermissionPromptNotification))
  const toolSnapshot = extractToolFields('copilot', normalizedEventName, hookPayload)
  const backgroundShellResultText =
    normalizedEventName === 'PostToolUse' ? readCopilotToolResultText(hookPayload) : undefined
  // Why: register only when the result proves the shell was actually backgrounded. An async shell
  // that finishes within `initial_wait` returns its output directly and would otherwise be tracked
  // as pending forever (no `shell_completed` notification ever comes for it).
  const startedShellId =
    normalizedEventName === 'PostToolUse' && isCopilotBackgroundShellLaunch(hookPayload)
      ? readStartedShellId(backgroundShellResultText)
      : undefined
  // Why: an agent that reads a shell to completion with `read_bash` gets the completion in the tool
  // result and Copilot then suppresses `shell_completed`; without this the shell would stay pending.
  const terminatedShellIds = readTerminatedShellIds(backgroundShellResultText)
  const subagentToolStarted =
    normalizedEventName === 'PreToolUse' && isCopilotBackgroundSubagentLaunch(hookPayload)
  // Why: a background task launch that fails (e.g. the task tool rejects a missing agent name) never
  // starts anything, so nothing will ever complete it; consume the entry the PreToolUse added or the
  // pane stays "Monitoring background tasks" for the rest of the session.
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

  let backgroundWorkState = getCopilotBackgroundWorkState(state, paneKey)
  if (normalizedEventName === 'SessionStart') {
    state.copilotBackgroundWorkByPaneKey.delete(paneKey)
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
    if (pendingCopilotBackgroundWork(backgroundWorkState) === 0) {
      state.copilotBackgroundWorkByPaneKey.delete(paneKey)
    } else {
      state.copilotBackgroundWorkByPaneKey.set(paneKey, backgroundWorkState)
    }
  } else if (subagentToolStarted) {
    const base = backgroundWorkState ?? createCopilotBackgroundWorkState()
    backgroundWorkState = {
      ...base,
      pendingUnidentifiedSubagentCount: base.pendingUnidentifiedSubagentCount + 1,
      leadStopped: preserveLeadStopped(backgroundWorkState)
    }
    state.copilotBackgroundWorkByPaneKey.set(paneKey, backgroundWorkState)
  } else if (normalizedEventName === 'SubagentStart') {
    const base = backgroundWorkState ?? createCopilotBackgroundWorkState()
    backgroundWorkState = {
      ...base,
      pendingUnidentifiedSubagentCount: Math.max(0, base.pendingUnidentifiedSubagentCount - 1),
      pendingSubagentLifecycleCount: base.pendingSubagentLifecycleCount + 1
    }
    state.copilotBackgroundWorkByPaneKey.set(paneKey, backgroundWorkState)
  } else if (failedBackgroundLaunch && backgroundWorkState) {
    const leadStopped = preserveLeadStopped(backgroundWorkState)
    backgroundWorkState = { ...consumeCopilotSubagent(backgroundWorkState), leadStopped }
    if (pendingCopilotBackgroundWork(backgroundWorkState) === 0) {
      state.copilotBackgroundWorkByPaneKey.delete(paneKey)
    } else {
      state.copilotBackgroundWorkByPaneKey.set(paneKey, backgroundWorkState)
    }
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
    // pending shell and settle the pane early. Either subagent completion consumes one subagent.
    backgroundWorkState =
      backgroundWorkCompletion === 'shell'
        ? consumeCopilotBackgroundShells(
            backgroundWorkState,
            completionShellId ? [completionShellId] : []
          )
        : consumeCopilotSubagent(backgroundWorkState)
    if (pendingCopilotBackgroundWork(backgroundWorkState) === 0) {
      state.copilotBackgroundWorkByPaneKey.delete(paneKey)
    } else {
      state.copilotBackgroundWorkByPaneKey.set(paneKey, backgroundWorkState)
    }
  } else if (normalizedEventName === 'SubagentStop' && backgroundWorkState) {
    backgroundWorkState = consumeCopilotSubagent(backgroundWorkState)
    if (pendingCopilotBackgroundWork(backgroundWorkState) === 0) {
      state.copilotBackgroundWorkByPaneKey.delete(paneKey)
    } else {
      state.copilotBackgroundWorkByPaneKey.set(paneKey, backgroundWorkState)
    }
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
    lastAssistantMessageIsToolOutput: snapshot.lastAssistantMessageIsToolOutput,
    ...(stopWaitsForBackgroundWork ? { workingMode: 'monitoring' as const } : {})
  })
}
