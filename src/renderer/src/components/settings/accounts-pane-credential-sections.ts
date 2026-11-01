import { useEffect, useRef, useState } from 'react'
import type { FeatureInteractionId } from '../../../../shared/feature-interaction-catalog'
import type {
  CopilotCredentialSectionModel,
  CopilotCredentialSource,
  DeepInfraCredentialSectionModel,
  DeepSeekCredentialSectionModel,
  FireworksCredentialSectionModel
} from './accounts-pane-types'
import { createCopilotCredentialActions } from './accounts-pane-copilot-actions'
import { createDeepInfraCredentialActions } from './accounts-pane-deepinfra-actions'
import { createDeepSeekCredentialActions } from './accounts-pane-deepseek-actions'
import { createFireworksCredentialActions } from './accounts-pane-fireworks-actions'

export type AccountsPaneCredentialSections = {
  deepSeek: DeepSeekCredentialSectionModel
  deepInfra: DeepInfraCredentialSectionModel
  fireworks: FireworksCredentialSectionModel
  copilot: CopilotCredentialSectionModel
}

type RecordFeatureInteraction = (featureId: FeatureInteractionId) => void

// Why: the four bridge-backed credential sections share one shape — masked
// draft, configured flag, busy flag, save/clear over the preload bridge, and a
// mount-time status refresh. Owning that state here keeps AccountsPane composing
// sections instead of growing past its max-lines budget.
export function useAccountsPaneCredentialSections(
  recordFeatureInteraction: RecordFeatureInteraction
): AccountsPaneCredentialSections {
  const deepSeek = useDeepSeekCredentials(recordFeatureInteraction)
  const deepInfra = useDeepInfraCredentials(recordFeatureInteraction)
  const fireworks = useFireworksCredentials(recordFeatureInteraction)
  const copilot = useCopilotCredentials(recordFeatureInteraction)
  return { deepSeek, deepInfra, fireworks, copilot }
}

function useDeepInfraCredentials(
  recordFeatureInteraction: RecordFeatureInteraction
): DeepInfraCredentialSectionModel {
  const [deepInfraApiKeyDraft, setDeepInfraApiKeyDraft] = useState('')
  const [deepInfraApiKeyConfigured, setDeepInfraApiKeyConfigured] = useState(false)
  const [deepInfraCredentialBusy, setDeepInfraCredentialBusy] = useState(false)
  const { saveDeepInfraApiKey, clearDeepInfraApiKey } = createDeepInfraCredentialActions({
    deepInfraApiKeyDraft,
    setDeepInfraApiKeyDraft,
    setDeepInfraApiKeyConfigured,
    setDeepInfraCredentialBusy,
    recordFeatureInteraction
  })

  useEffect(() => {
    const refresh = async (): Promise<void> => {
      try {
        const status = await window.api.deepinfraCredentials.getStatus()
        setDeepInfraApiKeyConfigured(status.apiKeyConfigured)
      } catch (error) {
        console.error('Failed to load DeepInfra credential status:', error)
      }
    }
    void refresh()
  }, [])

  return {
    deepInfraApiKeyDraft,
    setDeepInfraApiKeyDraft,
    deepInfraApiKeyConfigured,
    deepInfraCredentialBusy,
    saveDeepInfraApiKey,
    clearDeepInfraApiKey
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
