import type { CommitMessageAiSettings } from '../../../../shared/commit-message-ai-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  getCommitMessageAgentCapability,
  isCustomAgentId,
  type CommitMessageAgentChoice
} from '../../../../shared/commit-message-agent-spec'
import { resolveAiGenerationModel, resolveAiGenerationThinking } from '@/lib/ai-generation-settings'

export const EMPTY_COMMIT_MESSAGE_AI_SETTINGS: CommitMessageAiSettings = {
  enabled: false,
  agentId: null,
  selectedModelByAgent: {},
  selectedThinkingByModel: {},
  customPrompt: '',
  customAgentCommand: ''
}

export function readCommitMessageAiSettings(settings: GlobalSettings): CommitMessageAiSettings {
  return settings.commitMessageAi ?? EMPTY_COMMIT_MESSAGE_AI_SETTINGS
}

/** First-enable seeding: pick the agent and default model/effort only where nothing is stored. */
export function seedCommitMessageAiEnablePatch(
  config: CommitMessageAiSettings,
  seedAgentId: CommitMessageAgentChoice
): Partial<CommitMessageAiSettings> {
  const seedCapability = isCustomAgentId(seedAgentId)
    ? undefined
    : getCommitMessageAgentCapability(seedAgentId)
  const seedModel = seedCapability ? resolveAiGenerationModel(config, seedCapability) : null
  const seedThinking = seedModel ? resolveAiGenerationThinking(config, seedModel) : undefined
  const nextSelectedModelByAgent = { ...config.selectedModelByAgent }
  if (seedCapability && !nextSelectedModelByAgent[seedCapability.id]) {
    nextSelectedModelByAgent[seedCapability.id] = seedCapability.defaultModelId
  }
  const nextSelectedThinkingByModel = { ...config.selectedThinkingByModel }
  if (seedModel && seedThinking && !nextSelectedThinkingByModel[seedModel.id]) {
    nextSelectedThinkingByModel[seedModel.id] = seedThinking
  }
  return {
    enabled: true,
    agentId: seedAgentId,
    selectedModelByAgent: nextSelectedModelByAgent,
    selectedThinkingByModel: nextSelectedThinkingByModel
  }
}
