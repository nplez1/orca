import { useCallback, useState } from 'react'
import type { SessionSummaryAiSettings } from '../../../../shared/session-summary-ai-types'
import { readSessionSummaryAiSettings } from '../../../../shared/session-summary-ai'
import {
  aiGenerationAgentChangePatch,
  aiGenerationModelChangePatch,
  aiGenerationThinkingChangePatch,
  resolveAiGenerationSelection,
  type AiGenerationSelection
} from '@/lib/ai-generation-settings'
import { useAppStore } from '@/store'

export type SessionSummaryAiSettingsViewModel = AiGenerationSelection & {
  config: SessionSummaryAiSettings
  selectPortalRoot: HTMLElement | null
  setSelectPortalHost: (node: HTMLDivElement | null) => void
  onAgentChange: (newAgentId: string) => void
  onModelChange: (newModelId: string) => void
  onThinkingChange: (newLevelId: string) => void
  onCustomCommandChange: (value: string) => void
}

/** Agent/model/effort for the session-summary fold, stored on its own so tuning a
 *  summary never moves the commit-message choice (or the reverse). */
export function useSessionSummaryAiSettings(): SessionSummaryAiSettingsViewModel {
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const [selectPortalRoot, setSelectPortalRoot] = useState<HTMLElement | null>(null)
  const setSelectPortalHost = useCallback((node: HTMLDivElement | null) => {
    setSelectPortalRoot(node?.closest<HTMLElement>('[data-slot="dialog-content"]') ?? node)
  }, [])

  const config = readSessionSummaryAiSettings({ sessionSummaryAi: settings?.sessionSummaryAi })
  const selection = resolveAiGenerationSelection(config, {
    defaultTuiAgent: settings?.defaultTuiAgent,
    disabledTuiAgents: settings?.disabledTuiAgents
  })

  const writeConfig = (patch: Partial<SessionSummaryAiSettings>): void => {
    if (!settings) {
      return
    }
    updateSettings({ sessionSummaryAi: { ...config, ...patch } })
  }

  const writeSelectionPatch = (patch: Partial<SessionSummaryAiSettings>): void => {
    if (Object.keys(patch).length > 0) {
      writeConfig(patch)
    }
  }

  return {
    config,
    selectPortalRoot,
    setSelectPortalHost,
    ...selection,
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
    onCustomCommandChange: (value) => writeConfig({ customAgentCommand: value })
  }
}
