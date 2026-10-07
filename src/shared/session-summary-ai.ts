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
 * The model id the fold will actually pass, reconciled with whatever a probe reported.
 *
 * Unset means the agent's own default (`default`), which is what its CLI reads as "use my
 * configured model". A stored choice that the probe no longer lists goes back to that
 * default, because the pane must not display one model while the fold runs another.
 */
export function resolveSessionSummaryModelId(
  config: SessionSummaryAiSettings,
  agentId: TuiAgent
): string {
  const spec = getCommitMessageAgentSpec(agentId)
  if (!spec) {
    return ''
  }
  const stored = config.selectedModelByAgent[agentId]
  if (!stored || stored === spec.defaultModelId) {
    return spec.defaultModelId
  }
  // A static agent's list is authoritative: an id it does not carry is stale.
  if (spec.modelSource === 'static') {
    return spec.models.some((model) => model.id === stored) ? stored : spec.defaultModelId
  }
  // A dynamic agent's stub cannot judge an id, so only a probe that actually ran can.
  const discovered = readSessionSummaryDiscoveredModels({ sessionSummaryAi: config }, agentId)
  if (discovered.length === 0) {
    return stored
  }
  return discovered.some((model) => model.id === stored) ? stored : spec.defaultModelId
}

/**
 * Effort for the effective model, preferring what a probe reported for it.
 *
 * The spec only has static entries for static agents; a probed model's own levels are the
 * authority for a dynamic one, so a level the user picked is not silently dropped.
 */
export function resolveSessionSummaryThinkingLevel(
  config: SessionSummaryAiSettings,
  agentId: TuiAgent
): string | undefined {
  const modelId = resolveSessionSummaryModelId(config, agentId)
  if (!modelId) {
    return undefined
  }
  const probed = readSessionSummaryDiscoveredModels({ sessionSummaryAi: config }, agentId).find(
    (model) => model.id === modelId
  )
  const specModel = getCommitMessageModel(agentId, modelId)
  const levels = probed?.thinkingLevels ?? specModel?.thinkingLevels
  if (!levels?.length) {
    return undefined
  }
  const stored = config.selectedThinkingByModel[modelId]
  return stored && levels.some((level) => level.id === stored)
    ? stored
    : (probed?.defaultThinkingLevel ?? specModel?.defaultThinkingLevel)
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
  const modelId = resolveSessionSummaryModelId(config, agentChoice)
  if (!modelId) {
    return null
  }
  const thinkingLevel = resolveSessionSummaryThinkingLevel(config, agentChoice)
  const agentCommandOverride = input.agentCmdOverrides?.[agentChoice]?.trim()

  return {
    agentId: agentChoice,
    model: modelId,
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(agentCommandOverride ? { agentCommandOverride } : {})
  }
}
