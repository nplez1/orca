import { useEffect, useRef, useState } from 'react'
import type { FeatureInteractionId } from '../../../../shared/feature-interaction-catalog'
import type {
  CopilotCredentialSectionModel,
  CopilotCredentialSource,
  MiniMaxCredentialSectionModel
} from './accounts-pane-types'
import { createCopilotCredentialActions } from './accounts-pane-copilot-actions'
import { createMiniMaxCredentialActions } from './accounts-pane-minimax-actions'

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
  const [copilotTokenDraft, setCopilotTokenDraft] = useState('')
  const [copilotEnterpriseSlugDraft, setCopilotEnterpriseSlugDraft] = useState('')
  const [copilotCredentialSource, setCopilotCredentialSource] =
    useState<CopilotCredentialSource>('none')
  const [copilotGhSetupHint, setCopilotGhSetupHint] = useState<string | null>(null)
  const [copilotGhSetupHintCopied, setCopilotGhSetupHintCopied] = useState(false)
  const [copilotCredentialBusy, setCopilotCredentialBusy] = useState(false)
  const copyResetTimerRef = useRef<number | null>(null)
  const { saveCopilotCredentials, clearCopilotCredentials } = createCopilotCredentialActions({
    copilotTokenDraft,
    copilotCredentialSource,
    setCopilotTokenDraft,
    copilotEnterpriseSlugDraft,
    setCopilotEnterpriseSlugDraft,
    setCopilotCredentialSource,
    setCopilotGhSetupHint,
    setCopilotCredentialBusy,
    recordFeatureInteraction
  })

  useEffect(() => {
    return () => {
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current)
      }
    }
  }, [])

  const copyCopilotGhSetupHint = async (): Promise<void> => {
    if (!copilotGhSetupHint) {
      return
    }
    try {
      await window.api.ui.writeClipboardText(copilotGhSetupHint)
      setCopilotGhSetupHintCopied(true)
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current)
      }
      // Why: match the app's other inline copy buttons — swap the icon, then reset.
      copyResetTimerRef.current = window.setTimeout(() => {
        copyResetTimerRef.current = null
        setCopilotGhSetupHintCopied(false)
      }, 1500)
    } catch (error) {
      console.error('Failed to copy the GitHub CLI setup command:', error)
    }
  }

  useEffect(() => {
    const refresh = async (): Promise<void> => {
      try {
        const status = await window.api.copilotCredentials.getStatus()
        setCopilotCredentialSource(status.source)
        setCopilotGhSetupHint(status.ghSetupHint)
        // Why: the stored enterprise override keeps its token and slug together; the token
        // itself is never rendered.
        setCopilotEnterpriseSlugDraft(status.enterpriseSlug ?? '')
      } catch (error) {
        console.error('Failed to load GitHub Copilot credential status:', error)
      }
    }
    void refresh()
  }, [])

  return {
    copilotTokenDraft,
    setCopilotTokenDraft,
    copilotEnterpriseSlugDraft,
    setCopilotEnterpriseSlugDraft,
    copilotCredentialSource,
    copilotGhSetupHint,
    copilotGhSetupHintCopied,
    copyCopilotGhSetupHint,
    copilotCredentialBusy,
    saveCopilotCredentials,
    clearCopilotCredentials
  }
}
