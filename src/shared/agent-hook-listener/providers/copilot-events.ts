import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import { readFirstString } from '../interactive-tool'
import type { CopilotBackgroundWorkState, HookListenerState } from '../listener-state'
import { resolvePrompt, resolveToolState } from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'
import {
  isAskUserTool,
  normalizeCopilotEventName,
  readCopilotToolCall,
  resolveCopilotEventName
} from './copilot-tool-fields'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readCopilotToolInput(hookPayload: Record<string, unknown>): unknown {
  const toolCall = readCopilotToolCall(hookPayload)
  return (
    hookPayload.tool_input ??
    hookPayload.toolInput ??
    hookPayload.toolArgs ??
    hookPayload.input ??
    hookPayload.arguments ??
    toolCall.toolInputSource
  )
}

function readCopilotToolName(hookPayload: Record<string, unknown>): string | undefined {
  const toolCall = readCopilotToolCall(hookPayload)
  return readFirstString(hookPayload, ['tool_name', 'toolName', 'name']) ?? toolCall.toolName
}

function isCopilotBackgroundShellStart(
  normalizedEventName: unknown,
  hookPayload: Record<string, unknown>
): boolean {
  if (normalizedEventName !== 'PreToolUse') {
    return false
  }
  const toolName = readCopilotToolName(hookPayload)
  if (toolName?.toLowerCase() !== 'bash' && toolName?.toLowerCase() !== 'powershell') {
    return false
  }
  const toolInput = readCopilotToolInput(hookPayload)
  if (!isRecord(toolInput)) {
    return false
  }
  return (
    toolInput.background === true ||
    toolInput.runInBackground === true ||
    toolInput.run_in_background === true
  )
}

function isCopilotSubagentToolStart(
  normalizedEventName: unknown,
  hookPayload: Record<string, unknown>
): boolean {
  if (normalizedEventName !== 'PreToolUse') {
    return false
  }
  const toolName = readCopilotToolName(hookPayload)?.toLowerCase()
  return toolName === 'agent' || toolName === 'task'
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

function pendingCopilotBackgroundWork(work: CopilotBackgroundWorkState): number {
  return (
    work.pendingShellCount +
    work.pendingUnidentifiedSubagentCount +
    work.pendingSubagentLifecycleCount
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

// Why: PermissionRequest fires before allow/ask/deny (stays working), but the notification hook only fires once a prompt is actually shown to the user (copilot-cli 1.0.26, copilot-cli#2586), so permission_prompt is a real blocked signal.
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
  const isBlockingNotification =
    normalizedEventName === 'Notification' &&
    (notificationType === 'permission_prompt' || notificationType === 'elicitation_dialog')
  const toolSnapshot = extractToolFields('copilot', normalizedEventName, hookPayload)
  const backgroundShellStarted = isCopilotBackgroundShellStart(normalizedEventName, hookPayload)
  const subagentToolStarted = isCopilotSubagentToolStart(normalizedEventName, hookPayload)
  const backgroundWorkCompletion = isCopilotBackgroundWorkCompletionNotification(
    normalizedEventName,
    notificationType
  )
  const stopHookActive = isCopilotStopHookActive(hookPayload)
  let backgroundWorkState = getCopilotBackgroundWorkState(state, paneKey)
  if (normalizedEventName === 'SessionStart') {
    state.copilotBackgroundWorkByPaneKey.delete(paneKey)
    backgroundWorkState = undefined
  } else if (backgroundShellStarted) {
    backgroundWorkState = {
      pendingShellCount: (backgroundWorkState?.pendingShellCount ?? 0) + 1,
      pendingUnidentifiedSubagentCount: backgroundWorkState?.pendingUnidentifiedSubagentCount ?? 0,
      pendingSubagentLifecycleCount: backgroundWorkState?.pendingSubagentLifecycleCount ?? 0,
      leadStopped: false
    }
    state.copilotBackgroundWorkByPaneKey.set(paneKey, backgroundWorkState)
  } else if (subagentToolStarted) {
    backgroundWorkState = {
      pendingShellCount: backgroundWorkState?.pendingShellCount ?? 0,
      pendingUnidentifiedSubagentCount:
        (backgroundWorkState?.pendingUnidentifiedSubagentCount ?? 0) + 1,
      pendingSubagentLifecycleCount: backgroundWorkState?.pendingSubagentLifecycleCount ?? 0,
      leadStopped: false
    }
    state.copilotBackgroundWorkByPaneKey.set(paneKey, backgroundWorkState)
  } else if (normalizedEventName === 'SubagentStart') {
    backgroundWorkState = {
      pendingShellCount: backgroundWorkState?.pendingShellCount ?? 0,
      pendingUnidentifiedSubagentCount: Math.max(
        0,
        (backgroundWorkState?.pendingUnidentifiedSubagentCount ?? 0) - 1
      ),
      pendingSubagentLifecycleCount: (backgroundWorkState?.pendingSubagentLifecycleCount ?? 0) + 1,
      leadStopped: backgroundWorkState?.leadStopped ?? false
    }
    state.copilotBackgroundWorkByPaneKey.set(paneKey, backgroundWorkState)
  } else if (
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
    backgroundWorkState = {
      ...backgroundWorkState,
      pendingShellCount:
        backgroundWorkCompletion === 'shell'
          ? Math.max(0, backgroundWorkState.pendingShellCount - 1)
          : backgroundWorkState.pendingShellCount,
      pendingUnidentifiedSubagentCount:
        backgroundWorkCompletion === 'unidentified-subagent'
          ? Math.max(0, backgroundWorkState.pendingUnidentifiedSubagentCount - 1)
          : backgroundWorkState.pendingUnidentifiedSubagentCount
    }
    if (pendingCopilotBackgroundWork(backgroundWorkState) === 0) {
      state.copilotBackgroundWorkByPaneKey.delete(paneKey)
    } else {
      state.copilotBackgroundWorkByPaneKey.set(paneKey, backgroundWorkState)
    }
  } else if (normalizedEventName === 'SubagentStop' && backgroundWorkState) {
    backgroundWorkState = {
      ...backgroundWorkState,
      pendingSubagentLifecycleCount: Math.max(
        0,
        backgroundWorkState.pendingSubagentLifecycleCount - 1
      )
    }
    if (pendingCopilotBackgroundWork(backgroundWorkState) === 0) {
      state.copilotBackgroundWorkByPaneKey.delete(paneKey)
    } else {
      state.copilotBackgroundWorkByPaneKey.set(paneKey, backgroundWorkState)
    }
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
