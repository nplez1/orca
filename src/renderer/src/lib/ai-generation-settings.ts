// Agent/model/thinking selection shared by every settings surface that runs an
// agent CLI for text generation (Source Control AI, session summaries). Storage
// differs per surface; the selection rules must not.
import {
  CUSTOM_AGENT_ID,
  getCommitMessageAgentCapability,
  isCustomAgentId,
  resolveCommitMessageAgentChoice,
  type CommitMessageAgentCapability,
  type CommitMessageModelCapability,
  type DefaultTuiAgentPreference
} from '../../../shared/commit-message-agent-spec'
import type { CommitMessageAiSettings } from '../../../shared/commit-message-ai-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import { getAgentCatalog } from '@/lib/agent-catalog'

/** The fields a selection reads. Both stored blocks are a superset of this. */
export type AiGenerationSettingsConfig = Pick<
  CommitMessageAiSettings,
  'agentId' | 'selectedModelByAgent' | 'selectedThinkingByModel' | 'customAgentCommand'
>

export type AiGenerationSelectionSettings = {
  defaultTuiAgent?: DefaultTuiAgentPreference
  disabledTuiAgents?: Iterable<unknown> | null
  /** Models a CLI probe reported, keyed by the agent that reported them. Replaces
   *  that agent's spec list (a dynamic agent's spec list is only a stub), so the
   *  effort levels the probe found become selectable. Keyed by agent so another
   *  agent's probe can never be applied to the selected one. */
  discoveredModelsByAgent?: Partial<Record<TuiAgent, readonly CommitMessageModelCapability[]>>
}

export type AiGenerationSelection = {
  agentSelectValue: string | undefined
  activeCapability: CommitMessageAgentCapability | undefined
  activeModel: CommitMessageModelCapability | null
  activeThinking: string | undefined
  isCustom: boolean
  /** A configured or default agent this build cannot run non-interactively. */
  unsupportedAgentLabel: string | null
}

export function aiGenerationAgentLabel(
  agentId: TuiAgent,
  capability: CommitMessageAgentCapability
): string {
  return getAgentCatalog().find((agent) => agent.id === agentId)?.label ?? capability.label
}

export function agentCatalogLabel(agentId: string): string {
  return getAgentCatalog().find((agent) => agent.id === agentId)?.label ?? agentId
}

export function resolveAiGenerationModel(
  config: AiGenerationSettingsConfig,
  capability: CommitMessageAgentCapability
): CommitMessageModelCapability {
  const persisted = config.selectedModelByAgent[capability.id]
  if (persisted) {
    const found = capability.models.find((model) => model.id === persisted)
    if (found) {
      return found
    }
  }
  return (
    capability.models.find((model) => model.id === capability.defaultModelId) ??
    capability.models[0]
  )
}

export function resolveAiGenerationThinking(
  config: AiGenerationSettingsConfig,
  model: CommitMessageModelCapability
): string | undefined {
  if (!model.thinkingLevels) {
    return undefined
  }
  const persisted = config.selectedThinkingByModel[model.id]
  if (persisted && model.thinkingLevels.some((level) => level.id === persisted)) {
    return persisted
  }
  return model.defaultThinkingLevel
}

export function resolveAiGenerationSelection(
  config: AiGenerationSettingsConfig,
  settings: AiGenerationSelectionSettings
): AiGenerationSelection {
  const resolvedAgentId = resolveCommitMessageAgentChoice(
    config.agentId,
    settings.defaultTuiAgent,
    settings.disabledTuiAgents
  )
  const isCustom = isCustomAgentId(resolvedAgentId)
  const specCapability =
    resolvedAgentId && !isCustomAgentId(resolvedAgentId)
      ? getCommitMessageAgentCapability(resolvedAgentId)
      : undefined
  const discovered = (resolvedAgentId && settings.discoveredModelsByAgent?.[resolvedAgentId]) || []
  // Why the default entry: an unset choice runs the agent's own default, so the probe list
  // must still show it — otherwise the pane displays a model the fold will not run.
  const defaultEntry =
    specCapability &&
    discovered.length > 0 &&
    !discovered.some((model) => model.id === specCapability.defaultModelId)
      ? specCapability.models.find((model) => model.id === specCapability.defaultModelId)
      : undefined
  const activeCapability =
    specCapability && discovered.length > 0
      ? {
          ...specCapability,
          models: defaultEntry ? [defaultEntry, ...discovered] : [...discovered]
        }
      : specCapability
  const unsupportedConfiguredAgent =
    resolvedAgentId && !isCustom && !activeCapability ? resolvedAgentId : null
  const unsupportedDefaultAgent =
    resolvedAgentId === null &&
    !config.agentId &&
    settings.defaultTuiAgent &&
    settings.defaultTuiAgent !== 'blank'
      ? settings.defaultTuiAgent
      : null
  const activeModel = activeCapability ? resolveAiGenerationModel(config, activeCapability) : null

  return {
    agentSelectValue: activeCapability
      ? activeCapability.id
      : isCustom
        ? CUSTOM_AGENT_ID
        : undefined,
    activeCapability,
    activeModel,
    activeThinking: activeModel ? resolveAiGenerationThinking(config, activeModel) : undefined,
    isCustom,
    unsupportedAgentLabel: unsupportedConfiguredAgent
      ? agentCatalogLabel(unsupportedConfiguredAgent)
      : unsupportedDefaultAgent
        ? agentCatalogLabel(unsupportedDefaultAgent)
        : null
  }
}

/** Patches that only seed what is missing, so a switch never discards a picked level. */
export function aiGenerationAgentChangePatch(
  config: AiGenerationSettingsConfig,
  newAgentId: string
): Partial<AiGenerationSettingsConfig> {
  if (isCustomAgentId(newAgentId)) {
    return { agentId: CUSTOM_AGENT_ID }
  }
  const capability = getCommitMessageAgentCapability(newAgentId as TuiAgent)
  if (!capability) {
    return {}
  }
  const selectedModelByAgent = { ...config.selectedModelByAgent }
  if (!selectedModelByAgent[capability.id]) {
    selectedModelByAgent[capability.id] = capability.defaultModelId
  }
  const nextModel = resolveAiGenerationModel({ ...config, agentId: capability.id }, capability)
  const selectedThinkingByModel = { ...config.selectedThinkingByModel }
  if (
    nextModel.thinkingLevels &&
    nextModel.defaultThinkingLevel &&
    !selectedThinkingByModel[nextModel.id]
  ) {
    selectedThinkingByModel[nextModel.id] = nextModel.defaultThinkingLevel
  }
  return { agentId: capability.id, selectedModelByAgent, selectedThinkingByModel }
}

export function aiGenerationModelChangePatch(
  config: AiGenerationSettingsConfig,
  capability: CommitMessageAgentCapability,
  modelId: string
): Partial<AiGenerationSettingsConfig> {
  const model = capability.models.find((candidate) => candidate.id === modelId)
  if (!model) {
    return {}
  }
  const selectedThinkingByModel = { ...config.selectedThinkingByModel }
  if (model.thinkingLevels && model.defaultThinkingLevel && !selectedThinkingByModel[model.id]) {
    selectedThinkingByModel[model.id] = model.defaultThinkingLevel
  }
  return {
    selectedModelByAgent: { ...config.selectedModelByAgent, [capability.id]: model.id },
    selectedThinkingByModel
  }
}

export function aiGenerationThinkingChangePatch(
  config: AiGenerationSettingsConfig,
  model: CommitMessageModelCapability,
  levelId: string
): Partial<AiGenerationSettingsConfig> {
  return {
    selectedThinkingByModel: { ...config.selectedThinkingByModel, [model.id]: levelId }
  }
}
