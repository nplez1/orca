import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { FeatureInteractionId } from '../../../../shared/feature-interaction-catalog'
import type {
  CopilotCredentialSectionModel,
  CopilotGhStatus,
  MiniMaxCredentialSectionModel
} from './accounts-pane-types'
import { createMiniMaxCredentialActions } from './accounts-pane-minimax-actions'
import { useAppStore } from '../../store'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'

export type AccountsPaneCredentialSections = {
  miniMax: MiniMaxCredentialSectionModel
  copilot: CopilotCredentialSectionModel
}

type RecordFeatureInteraction = (featureId: FeatureInteractionId) => void

// Why: the bridge-backed credential sections share one shape — masked
// draft, configured flag, busy flag, save/clear over the preload bridge, and a
// mount-time status refresh. Owning that state here keeps AccountsPane composing
// sections instead of growing past its max-lines budget.
export function useAccountsPaneCredentialSections(
  recordFeatureInteraction: RecordFeatureInteraction
): AccountsPaneCredentialSections {
  const miniMax = useMiniMaxCredentials(recordFeatureInteraction)
  const copilot = useCopilotCredentials(recordFeatureInteraction)
  return { miniMax, copilot }
}

function useMiniMaxCredentials(
  recordFeatureInteraction: RecordFeatureInteraction
): MiniMaxCredentialSectionModel {
  const [miniMaxCookieDraft, setMiniMaxCookieDraft] = useState('')
  const [miniMaxApiKeyDraft, setMiniMaxApiKeyDraft] = useState('')
  const [miniMaxApiKeyConfigured, setMiniMaxApiKeyConfigured] = useState(false)
  const [miniMaxConfigured, setMiniMaxConfigured] = useState(false)
  const [miniMaxCredentialBusy, setMiniMaxCredentialBusy] = useState(false)
  const { saveMiniMaxCookie, clearMiniMaxCookie, saveMiniMaxApiKey, clearMiniMaxApiKey } =
    createMiniMaxCredentialActions({
      miniMaxCookieDraft,
      setMiniMaxCookieDraft,
      miniMaxApiKeyDraft,
      setMiniMaxApiKeyDraft,
      setMiniMaxApiKeyConfigured,
      setMiniMaxConfigured,
      setMiniMaxCredentialBusy,
      recordFeatureInteraction
    })

  useEffect(() => {
    const refresh = async (): Promise<void> => {
      try {
        const status = await window.api.minimaxCredentials.getStatus()
        setMiniMaxConfigured(status.cookieConfigured)
        setMiniMaxApiKeyConfigured(status.apiKeyConfigured)
      } catch (error) {
        console.error('Failed to load MiniMax credential status:', error)
      }
    }
    void refresh()
  }, [])

  return {
    miniMaxApiKeyDraft,
    setMiniMaxApiKeyDraft,
    miniMaxApiKeyConfigured,
    saveMiniMaxApiKey,
    clearMiniMaxApiKey,
    miniMaxCookieDraft,
    setMiniMaxCookieDraft,
    miniMaxConfigured,
    miniMaxCredentialBusy,
    saveMiniMaxCookie,
    clearMiniMaxCookie
  }
}

function useCopilotCredentials(
  recordFeatureInteraction: RecordFeatureInteraction
): CopilotCredentialSectionModel {
  const [copilotGhStatus, setCopilotGhStatus] = useState<CopilotGhStatus | null>(null)
  const [copilotGhSetupHint, setCopilotGhSetupHint] = useState<string | null>(null)
  const [copilotCredentialBusy, setCopilotCredentialBusy] = useState(false)
  const [copilotTerminalOpen, setCopilotTerminalOpen] = useState(false)
  const refreshRateLimits = useAppStore((s) => s.refreshRateLimits)
  const mountedRef = useMountedRef()

  useEffect(() => {
    const readStatus = async (): Promise<void> => {
      const status = await window.api.copilotCredentials.getStatus()
      if (mountedRef.current) {
        setCopilotGhStatus(status.ghStatus)
        setCopilotGhSetupHint(status.ghSetupHint)
      }
    }
    readStatus().catch((error: unknown) => {
      console.error('Failed to load the GitHub Copilot status:', error)
    })
  }, [mountedRef])

  // Why the full refresh: main re-probes gh for this read, and the provider only becomes
  // visible once a fetch cycle picks that probe up from its cache.
  const recheckCopilotCredentials = async (): Promise<void> => {
    setCopilotCredentialBusy(true)
    try {
      const status = await window.api.copilotCredentials.getStatus()
      if (mountedRef.current) {
        setCopilotGhStatus(status.ghStatus)
        setCopilotGhSetupHint(status.ghSetupHint)
      }
      await refreshRateLimits()
      recordFeatureInteraction('usage-tracking')
    } catch (error) {
      console.error('Failed to re-check the GitHub Copilot status:', error)
    } finally {
      if (mountedRef.current) {
        setCopilotCredentialBusy(false)
      }
    }
  }

  const copyCopilotGhSetupHint = async (): Promise<void> => {
    if (!copilotGhSetupHint) {
      return
    }
    try {
      await window.api.ui.writeClipboardText(copilotGhSetupHint)
      toast.success(
        translate(
          'auto.components.settings.accounts.pane.credential.sections.2fa282378a',
          'Copied command.'
        )
      )
    } catch (error) {
      console.error('Failed to copy the GitHub CLI setup command:', error)
    }
  }

  return {
    copilotGhStatus,
    copilotGhSetupHint,
    copilotCredentialBusy,
    copilotTerminalOpen,
    openCopilotTerminal: () => setCopilotTerminalOpen(true),
    closeCopilotTerminal: () => setCopilotTerminalOpen(false),
    recheckCopilotCredentials,
    copyCopilotGhSetupHint
  }
}
