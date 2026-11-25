import { extractToolResponseText, readFirstString } from '../../interactive-tool'
import { readCopilotToolCall, readCopilotToolInput } from './copilot-tool-fields'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function readCopilotToolName(hookPayload: Record<string, unknown>): string | undefined {
  const toolCall = readCopilotToolCall(hookPayload)
  return readFirstString(hookPayload, ['tool_name', 'toolName', 'name']) ?? toolCall.toolName
}

// Why: Copilot's shell tool starts background work with `mode: 'async'` (a shell readable via
// read_bash that reports `shell_completed`) or `detach: true` (a detached process reporting
// `shell_detached_completed`). There is no `background`/`runInBackground` field, so matching those
// names missed every real background shell.
export function isCopilotBackgroundShellLaunch(hookPayload: Record<string, unknown>): boolean {
  const toolName = readCopilotToolName(hookPayload)
  if (toolName?.toLowerCase() !== 'bash' && toolName?.toLowerCase() !== 'powershell') {
    return false
  }
  const toolInput = readCopilotToolInput(hookPayload)
  return isRecord(toolInput) && (toolInput.mode === 'async' || toolInput.detach === true)
}

// Why: the `task` tool runs an agent in `sync` or `background` mode. Only background mode outlives
// the lead turn; a sync task completes with its PostToolUse, and counting it left the pane
// working for the rest of the session (the general-purpose agent emits no subagentStart/subagentStop,
// so nothing ever decremented it).
export function isCopilotBackgroundSubagentLaunch(hookPayload: Record<string, unknown>): boolean {
  const toolName = readCopilotToolName(hookPayload)?.toLowerCase()
  if (toolName !== 'agent' && toolName !== 'task') {
    return false
  }
  const toolInput = readCopilotToolInput(hookPayload)
  return isRecord(toolInput) && toolInput.mode === 'background'
}

export function isCopilotBackgroundWorkCompletionNotification(
  normalizedEventName: unknown,
  notificationType: string | undefined
): 'shell' | 'subagent' | undefined {
  if (normalizedEventName !== 'Notification') {
    return undefined
  }
  if (notificationType === 'shell_completed' || notificationType === 'shell_detached_completed') {
    return 'shell'
  }
  // Why: `agent_idle` is a background agent ending a turn to wait for `write_agent`; nothing of it
  // runs until a write_agent re-engages it, so it ends that agent's work like `agent_completed`.
  if (notificationType === 'agent_completed' || notificationType === 'agent_idle') {
    return 'subagent'
  }
  return undefined
}

export function readCopilotShellDescription(
  hookPayload: Record<string, unknown>
): string | undefined {
  const toolInput = readCopilotToolInput(hookPayload)
  return isRecord(toolInput) ? readFirstString(toolInput, ['description', 'command']) : undefined
}

export function readCopilotToolResultText(
  hookPayload: Record<string, unknown>
): string | undefined {
  return (
    extractToolResponseText(hookPayload.tool_result) ??
    extractToolResponseText(hookPayload.toolResult) ??
    extractToolResponseText(hookPayload.tool_response) ??
    extractToolResponseText(hookPayload.toolResponse)
  )
}

// Why: these tools only read, message or list agents (or run shell commands); their output can
// quote another agent's launch line, which must not register that agent again.
const COPILOT_NON_LAUNCH_TOOLS = new Set([
  'read_agent',
  'write_agent',
  'list_agents',
  'bash',
  'powershell',
  'read_bash',
  'write_bash',
  'stop_bash',
  'read_powershell',
  'write_powershell',
  'stop_powershell'
])

export function isCopilotAgentLaunchResultTool(toolName: string | undefined): boolean {
  return toolName !== undefined && !COPILOT_NON_LAUNCH_TOOLS.has(toolName.toLowerCase())
}

/** Copilot's own refusals for a `write_agent` that reached no agent. */
const COPILOT_WRITE_AGENT_UNDELIVERED_RE =
  /No agent found|not accepting messages|only supports background agents|No matching agents|Delivery failed|Failed to deliver/i

/** The agents a delivered `write_agent` addressed by id; a `scope` send names none. */
export function readCopilotWriteAgentTargets(hookPayload: Record<string, unknown>): string[] {
  const toolInput = readCopilotToolInput(hookPayload)
  if (readCopilotToolName(hookPayload)?.toLowerCase() !== 'write_agent' || !isRecord(toolInput)) {
    return []
  }
  const toolResult = hookPayload.tool_result ?? hookPayload.toolResult
  const resultType = isRecord(toolResult)
    ? readFirstString(toolResult, ['result_type', 'resultType'])
    : undefined
  const resultText = readCopilotToolResultText(hookPayload)
  if (
    (resultType !== undefined && resultType !== 'success') ||
    (resultText && COPILOT_WRITE_AGENT_UNDELIVERED_RE.test(resultText))
  ) {
    return []
  }
  const ids: unknown[] =
    typeof toolInput.agent_id === 'string' && toolInput.agent_id.length > 0
      ? [toolInput.agent_id]
      : Array.isArray(toolInput.agent_ids)
        ? toolInput.agent_ids
        : []
  return ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
}

/** The single agent a `read_agent`/`write_agent` call addressed. */
export function readCopilotRequestedAgentId(hookPayload: Record<string, unknown>): unknown {
  const toolInput = readCopilotToolInput(hookPayload)
  return isRecord(toolInput) ? toolInput.agent_id : undefined
}
