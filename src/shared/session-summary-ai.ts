// Which agent CLI, model, and thinking level fold a session summary.
//
// Deliberately its own setting rather than a Source Control AI operation: a fold is
// not a source-control action (it feeds no command template and no PR/branch flow),
// and borrowing the commit-message recipe meant a user could not change summary cost
// without changing commit messages. See docs/reference/session-summary.md.
import {
  CUSTOM_AGENT_ID,
  getCommitMessageAgentSpec,
  getCommitMessageModel,
  isCustomAgentId,
  resolveCommitMessageAgentChoice,
  type DefaultTuiAgentPreference
} from './commit-message-agent-spec'
import type { ResolvedSourceControlAiGenerationParams } from './source-control-ai'
import type { SessionSummaryAiSettings } from './session-summary-ai-types'
import { LOCAL_COMMIT_MESSAGE_HOST_KEY } from './commit-message-host-key'
import type { CommitMessageAiModelCapability } from './commit-message-ai-types'
import type { TuiAgent } from './tui-agent'

export type SessionSummaryAiSettingsInput = {
  sessionSummaryAi?: SessionSummaryAiSettings | null
  /** Fallback agent when nothing is configured; the workspace default. */
  defaultTuiAgent?: DefaultTuiAgentPreference
  disabledTuiAgents?: Iterable<unknown> | null
  agentCmdOverrides?: Partial<Record<string, string>>
}

export const EMPTY_SESSION_SUMMARY_AI_SETTINGS: SessionSummaryAiSettings = {
  agentId: null,
  selectedModelByAgent: {},
  selectedThinkingByModel: {},
  customAgentCommand: ''
}

export function readSessionSummaryAiSettings(
  settings: Pick<SessionSummaryAiSettingsInput, 'sessionSummaryAi'>
): SessionSummaryAiSettings {
  return settings.sessionSummaryAi ?? EMPTY_SESSION_SUMMARY_AI_SETTINGS
}

/**
 * Models a probe reported for this agent, local slot first.
 *
 * The fold spawns the agent CLI on the local machine, so the picker resolves the
 * local list even though storage is host-keyed — a remote host's models are not
 * runnable by the local spawn.
 */
export function readSessionSummaryDiscoveredModels(
  settings: Pick<SessionSummaryAiSettingsInput, 'sessionSummaryAi'>,
  agentId: TuiAgent
): CommitMessageAiModelCapability[] {
  const config = readSessionSummaryAiSettings(settings)
  return (
    config.discoveredModelsByAgent?.[agentId] ??
    config.discoveredModelsByAgentByHost?.[LOCAL_COMMIT_MESSAGE_HOST_KEY]?.[agentId] ??
    []
  )
}

/**
 * Resolves the fold's agent/model/thinking, or null when nothing usable is selected
 * — custom with an empty command, or every candidate agent disabled.
 */
export function resolveSessionSummaryAiParams(
  input: SessionSummaryAiSettingsInput
): ResolvedSourceControlAiGenerationParams | null {
  const config = readSessionSummaryAiSettings(input)
  const agentChoice = resolveCommitMessageAgentChoice(
    config.agentId,
    input.defaultTuiAgent,
    input.disabledTuiAgents
  )
  if (!agentChoice) {
    return null
  }

  const customAgentCommand = config.customAgentCommand.trim()
  if (isCustomAgentId(agentChoice)) {
    return customAgentCommand ? { agentId: CUSTOM_AGENT_ID, model: '', customAgentCommand } : null
  }

  const spec = getCommitMessageAgentSpec(agentChoice)
  if (!spec) {
    return null
  }
  // A stored model the agent no longer offers (or a host that no longer reports it)
  // falls back to the agent's default rather than failing the fold.
  const model =
    getCommitMessageModel(agentChoice, config.selectedModelByAgent[agentChoice] ?? '') ??
    getCommitMessageModel(agentChoice, spec.defaultModelId)
  if (!model) {
    return null
  }

  const persistedThinking = config.selectedThinkingByModel[model.id]
  const thinkingLevel = model.thinkingLevels?.some((level) => level.id === persistedThinking)
    ? persistedThinking
    : model.defaultThinkingLevel
  const agentCommandOverride = input.agentCmdOverrides?.[agentChoice]?.trim()

  return {
    agentId: agentChoice,
    model: model.id,
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(agentCommandOverride ? { agentCommandOverride } : {})
  }
}
