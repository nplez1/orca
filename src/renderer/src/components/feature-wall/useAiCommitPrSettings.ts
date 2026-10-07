import { useCallback, useState } from 'react'
import type { CommitMessageAiSettings } from '../../../../shared/commit-message-ai-types'
import { resolveCommitMessageAgentChoice } from '../../../../shared/commit-message-agent-spec'
import {
  aiGenerationAgentChangePatch,
  aiGenerationModelChangePatch,
  aiGenerationThinkingChangePatch,
  resolveAiGenerationSelection,
  type AiGenerationSelection
} from '@/lib/ai-generation-settings'
import { useAppStore } from '@/store'
import {
  EMPTY_COMMIT_MESSAGE_AI_SETTINGS,
  readCommitMessageAiSettings,
  seedCommitMessageAiEnablePatch
} from './ai-commit-pr-settings-helpers'

export type AiCommitPrSettingsViewModel = AiGenerationSelection & {
  config: CommitMessageAiSettings
  selectPortalRoot: HTMLElement | null
  setSelectPortalHost: (node: HTMLDivElement | null) => void
  toggleAi: () => void
  onAgentChange: (newAgentId: string) => void
  onModelChange: (newModelId: string) => void
  onThinkingChange: (newLevelId: string) => void
  writeConfig: (patch: Partial<CommitMessageAiSettings>) => void
}

export function useAiCommitPrSettings(): AiCommitPrSettingsViewModel {
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const [selectPortalRoot, setSelectPortalRoot] = useState<HTMLElement | null>(null)
  const setSelectPortalHost = useCallback((node: HTMLDivElement | null) => {
    setSelectPortalRoot(
      node?.closest<HTMLElement>('[data-onboarding-overlay], [data-slot="dialog-content"]') ?? node
    )
  }, [])

  const config = settings ? readCommitMessageAiSettings(settings) : EMPTY_COMMIT_MESSAGE_AI_SETTINGS
  const selection = resolveAiGenerationSelection(config, {
    defaultTuiAgent: settings?.defaultTuiAgent,
    disabledTuiAgents: settings?.disabledTuiAgents
  })

  const writeConfig = (patch: Partial<CommitMessageAiSettings>): void => {
    if (!settings) {
      return
    }
    updateSettings({ commitMessageAi: { ...config, ...patch } })
  }

  const writeSelectionPatch = (patch: Partial<CommitMessageAiSettings>): void => {
    if (Object.keys(patch).length > 0) {
      writeConfig(patch)
    }
  }

  const toggleAi = (): void => {
    if (config.enabled) {
      writeConfig({ enabled: false })
      return
    }
    const seedAgentId = resolveCommitMessageAgentChoice(
      config.agentId,
      settings?.defaultTuiAgent,
      settings?.disabledTuiAgents
    )
    writeConfig(
      seedAgentId
        ? seedCommitMessageAiEnablePatch(config, seedAgentId)
        : { enabled: true, agentId: null }
    )
  }

  return {
    config,
    selectPortalRoot,
    setSelectPortalHost,
    ...selection,
    toggleAi,
    onAgentChange: (newAgentId) =>
      writeSelectionPatch(aiGenerationAgentChangePatch(config, newAgentId)),
    onModelChange: (newModelId) => {
      if (selection.activeCapability) {
        writeSelectionPatch(
          aiGenerationModelChangePatch(config, selection.activeCapability, newModelId)
        )
      }
    },
    onThinkingChange: (newLevelId) => {
      if (selection.activeModel) {
        writeSelectionPatch(
          aiGenerationThinkingChangePatch(config, selection.activeModel, newLevelId)
        )
      }
    },
    writeConfig
  }
}
