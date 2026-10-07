import { useCallback, useEffect, useState } from 'react'
import type { SessionSummaryAiSettings } from '../../../../shared/session-summary-ai-types'
import {
  readSessionSummaryAiSettings,
  readSessionSummaryDiscoveredModels
} from '../../../../shared/session-summary-ai'
import { LOCAL_COMMIT_MESSAGE_HOST_KEY } from '../../../../shared/commit-message-host-key'
import type { CommitMessageAiModelCapability } from '../../../../shared/commit-message-ai-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  aiGenerationAgentChangePatch,
  aiGenerationModelChangePatch,
  aiGenerationThinkingChangePatch,
  resolveAiGenerationSelection,
  type AiGenerationSelection
} from '@/lib/ai-generation-settings'
import { useAppStore } from '@/store'

export type SessionSummaryAiDiscoveryStatus = 'idle' | 'discovering' | 'unavailable'

export type SessionSummaryAiSettingsViewModel = AiGenerationSelection & {
  config: SessionSummaryAiSettings
  selectPortalRoot: HTMLElement | null
  setSelectPortalHost: (node: HTMLDivElement | null) => void
  discoveryStatus: SessionSummaryAiDiscoveryStatus
  onAgentChange: (newAgentId: string) => void
  onModelChange: (newModelId: string) => void
  onThinkingChange: (newLevelId: string) => void
  onCustomCommandChange: (value: string) => void
  /** Drops the cached probe result so the next render re-lists the agent's models. */
  onRefreshModels: () => void
}

/** Agent/model/effort for the session-summary fold, stored on its own so tuning a
 *  summary never moves the commit-message choice (or the reverse).
 *
 *  A dynamic agent (Pi) ships only a stub model list, so its CLI is asked once per
 *  agent and the answer is cached — host-keyed on disk, resolved for the local host,
 *  because that is where the fold spawns the agent. */
export function useSessionSummaryAiSettings(): SessionSummaryAiSettingsViewModel {
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const [selectPortalRoot, setSelectPortalRoot] = useState<HTMLElement | null>(null)
  const [discoveryStatus, setDiscoveryStatus] = useState<SessionSummaryAiDiscoveryStatus>('idle')
  const setSelectPortalHost = useCallback((node: HTMLDivElement | null) => {
    setSelectPortalRoot(node?.closest<HTMLElement>('[data-slot="dialog-content"]') ?? node)
  }, [])

  const config = readSessionSummaryAiSettings({ sessionSummaryAi: settings?.sessionSummaryAi })
  const selectionSettings = {
    defaultTuiAgent: settings?.defaultTuiAgent,
    disabledTuiAgents: settings?.disabledTuiAgents
  }
  // Two passes: the selected agent decides which discovered list applies.
  const baseSelection = resolveAiGenerationSelection(config, selectionSettings)
  const selectedAgentId = baseSelection.activeCapability?.id
  const discoveredModels = selectedAgentId
    ? readSessionSummaryDiscoveredModels({ sessionSummaryAi: config }, selectedAgentId)
    : []
  const selection =
    selectedAgentId && discoveredModels.length > 0
      ? resolveAiGenerationSelection(config, {
          ...selectionSettings,
          discoveredModelsByAgent: { [selectedAgentId]: discoveredModels }
        })
      : baseSelection

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

  const cacheDiscoveredModels = useCallback(
    (agentId: TuiAgent, models: CommitMessageAiModelCapability[]): void => {
      // Read the latest settings: the probe resolves after other writes may have landed.
      const latest = useAppStore.getState().settings
      if (!latest) {
        return
      }
      const current = readSessionSummaryAiSettings({ sessionSummaryAi: latest.sessionSummaryAi })
      updateSettings({
        sessionSummaryAi: {
          ...current,
          discoveredModelsByAgent: { ...current.discoveredModelsByAgent, [agentId]: models },
          discoveredModelsByAgentByHost: {
            ...current.discoveredModelsByAgentByHost,
            [LOCAL_COMMIT_MESSAGE_HOST_KEY]: {
              ...current.discoveredModelsByAgentByHost?.[LOCAL_COMMIT_MESSAGE_HOST_KEY],
              [agentId]: models
            }
          }
        }
      })
    },
    [updateSettings]
  )

  const needsDiscovery = Boolean(
    settings &&
    selectedAgentId &&
    baseSelection.activeCapability?.modelSource === 'dynamic' &&
    discoveredModels.length === 0
  )

  // A cached list is only as fresh as the last probe, so the pane offers a refresh rather
  // than leaving models the CLI started reporting unreachable for the life of the install.
  const onRefreshModels = useCallback((): void => {
    const latest = useAppStore.getState().settings
    if (!latest || !selectedAgentId) {
      return
    }
    const current = readSessionSummaryAiSettings({ sessionSummaryAi: latest.sessionSummaryAi })
    const discoveredModelsByAgent = { ...current.discoveredModelsByAgent }
    delete discoveredModelsByAgent[selectedAgentId]
    const localSlot = current.discoveredModelsByAgentByHost?.[LOCAL_COMMIT_MESSAGE_HOST_KEY]
    const discoveredModelsByAgentByHost = { ...current.discoveredModelsByAgentByHost }
    if (localSlot) {
      const nextLocalSlot = { ...localSlot }
      delete nextLocalSlot[selectedAgentId]
      discoveredModelsByAgentByHost[LOCAL_COMMIT_MESSAGE_HOST_KEY] = nextLocalSlot
    }
    setDiscoveryStatus('idle')
    updateSettings({
      sessionSummaryAi: { ...current, discoveredModelsByAgent, discoveredModelsByAgentByHost }
    })
  }, [selectedAgentId, updateSettings])

  useEffect(() => {
    if (!needsDiscovery || !selectedAgentId) {
      setDiscoveryStatus('idle')
      return
    }
    let cancelled = false
    setDiscoveryStatus('discovering')
    void window.api.git
      .discoverCommitMessageModels({ agentId: selectedAgentId })
      .then((result) => {
        if (cancelled) {
          return
        }
        // Cache only a real probe: a spec-origin result would persist the stub list
        // as though the CLI had answered, and it would never be retried.
        if (!result.success || result.catalogOrigin !== 'probe' || result.models.length === 0) {
          setDiscoveryStatus('unavailable')
          return
        }
        setDiscoveryStatus('idle')
        cacheDiscoveredModels(selectedAgentId, result.models)
      })
      .catch(() => {
        if (!cancelled) {
          setDiscoveryStatus('unavailable')
        }
      })
    return () => {
      cancelled = true
    }
  }, [needsDiscovery, selectedAgentId, cacheDiscoveredModels])

  return {
    config,
    selectPortalRoot,
    setSelectPortalHost,
    discoveryStatus,
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
    onCustomCommandChange: (value) => writeConfig({ customAgentCommand: value }),
    onRefreshModels
  }
}
