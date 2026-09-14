import { useEffect, useState } from 'react'
import type { FeatureInteractionId } from '../../../../shared/feature-interaction-catalog'
import type {
  DeepSeekCredentialSectionModel,
  MiniMaxCredentialSectionModel
} from './accounts-pane-types'
import { createDeepSeekCredentialActions } from './accounts-pane-deepseek-actions'
import { createMiniMaxCredentialActions } from './accounts-pane-minimax-actions'

export type AccountsPaneCredentialSections = {
  miniMax: MiniMaxCredentialSectionModel
  deepSeek: DeepSeekCredentialSectionModel
}

type RecordFeatureInteraction = (featureId: FeatureInteractionId) => void

// Why: the two bridge-backed credential sections share one shape — masked
// draft, configured flag, busy flag, save/clear over the preload bridge, and a
// mount-time status refresh. Owning that state here keeps AccountsPane composing
// sections instead of growing past its max-lines budget.
export function useAccountsPaneCredentialSections(
  recordFeatureInteraction: RecordFeatureInteraction
): AccountsPaneCredentialSections {
  const miniMax = useMiniMaxCredentials(recordFeatureInteraction)
  const deepSeek = useDeepSeekCredentials(recordFeatureInteraction)
  return { miniMax, deepSeek }
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
