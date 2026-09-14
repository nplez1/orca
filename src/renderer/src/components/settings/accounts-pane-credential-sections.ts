import { useEffect, useRef, useState } from 'react'
import type { FeatureInteractionId } from '../../../../shared/feature-interaction-catalog'
import type {
  CopilotCredentialSectionModel,
  CopilotCredentialSource,
  DeepSeekCredentialSectionModel,
  FireworksCredentialSectionModel,
  MiniMaxCredentialSectionModel
} from './accounts-pane-types'
import { createCopilotCredentialActions } from './accounts-pane-copilot-actions'
import { createDeepSeekCredentialActions } from './accounts-pane-deepseek-actions'
import { createFireworksCredentialActions } from './accounts-pane-fireworks-actions'
import { createMiniMaxCredentialActions } from './accounts-pane-minimax-actions'

export type AccountsPaneCredentialSections = {
  miniMax: MiniMaxCredentialSectionModel
  deepSeek: DeepSeekCredentialSectionModel
  fireworks: FireworksCredentialSectionModel
  copilot: CopilotCredentialSectionModel
}

type RecordFeatureInteraction = (featureId: FeatureInteractionId) => void

// Why: the three bridge-backed credential sections share one shape — masked
// draft, configured flag, busy flag, save/clear over the preload bridge, and a
// mount-time status refresh. Owning that state here keeps AccountsPane composing
// sections instead of growing past its max-lines budget.
export function useAccountsPaneCredentialSections(
  recordFeatureInteraction: RecordFeatureInteraction
): AccountsPaneCredentialSections {
  const miniMax = useMiniMaxCredentials(recordFeatureInteraction)
  const deepSeek = useDeepSeekCredentials(recordFeatureInteraction)
  const fireworks = useFireworksCredentials(recordFeatureInteraction)
  const copilot = useCopilotCredentials(recordFeatureInteraction)
  return { miniMax, deepSeek, fireworks, copilot }
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

function useDeepSeekCredentials(
  recordFeatureInteraction: RecordFeatureInteraction
): DeepSeekCredentialSectionModel {
  const [deepSeekApiKeyDraft, setDeepSeekApiKeyDraft] = useState('')
  const [deepSeekApiKeyConfigured, setDeepSeekApiKeyConfigured] = useState(false)
  const [deepSeekCredentialBusy, setDeepSeekCredentialBusy] = useState(false)
  const { saveDeepSeekApiKey, clearDeepSeekApiKey } = createDeepSeekCredentialActions({
    deepSeekApiKeyDraft,
    setDeepSeekApiKeyDraft,
    setDeepSeekApiKeyConfigured,
    setDeepSeekCredentialBusy,
    recordFeatureInteraction
  })

  useEffect(() => {
    const refresh = async (): Promise<void> => {
      try {
        const status = await window.api.deepseekCredentials.getStatus()
        setDeepSeekApiKeyConfigured(status.apiKeyConfigured)
      } catch (error) {
        console.error('Failed to load DeepSeek credential status:', error)
      }
    }
    void refresh()
  }, [])

  return {
    deepSeekApiKeyDraft,
    setDeepSeekApiKeyDraft,
    deepSeekApiKeyConfigured,
    deepSeekCredentialBusy,
    saveDeepSeekApiKey,
    clearDeepSeekApiKey
  }
}

function useFireworksCredentials(
  recordFeatureInteraction: RecordFeatureInteraction
): FireworksCredentialSectionModel {
  const [fireworksApiKeyDraft, setFireworksApiKeyDraft] = useState('')
  const [fireworksAccountIdDraft, setFireworksAccountIdDraft] = useState('')
  const [fireworksApiKeyConfigured, setFireworksApiKeyConfigured] = useState(false)
  const [fireworksCredentialBusy, setFireworksCredentialBusy] = useState(false)
  const { saveFireworksCredentials, clearFireworksCredentials } = createFireworksCredentialActions({
    fireworksApiKeyDraft,
    fireworksApiKeyConfigured,
    setFireworksApiKeyDraft,
    fireworksAccountIdDraft,
    setFireworksAccountIdDraft,
    setFireworksApiKeyConfigured,
    setFireworksCredentialBusy,
    recordFeatureInteraction
  })

  useEffect(() => {
    const refresh = async (): Promise<void> => {
      try {
        const status = await window.api.fireworksCredentials.getStatus()
        setFireworksApiKeyConfigured(status.apiKeyConfigured)
        // Why: the key and the optional override share one stored file, so the
        // status seeds the override field too; the key itself is never rendered.
        setFireworksAccountIdDraft(status.accountIdOverride ?? '')
      } catch (error) {
        console.error('Failed to load Fireworks credential status:', error)
      }
    }
    void refresh()
  }, [])

  return {
    fireworksApiKeyDraft,
    setFireworksApiKeyDraft,
    fireworksAccountIdDraft,
    setFireworksAccountIdDraft,
    fireworksApiKeyConfigured,
    fireworksCredentialBusy,
    saveFireworksCredentials,
    clearFireworksCredentials
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
        // Why: the token and the slug share one stored file, so the status seeds
        // the slug field too; the token itself is never rendered.
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
