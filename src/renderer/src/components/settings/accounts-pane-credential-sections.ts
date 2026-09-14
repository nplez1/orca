import { useEffect, useState } from 'react'
import type { FeatureInteractionId } from '../../../../shared/feature-interaction-catalog'
import type {
  FireworksCredentialSectionModel,
  MiniMaxCredentialSectionModel
} from './accounts-pane-types'
import { createFireworksCredentialActions } from './accounts-pane-fireworks-actions'
import { createMiniMaxCredentialActions } from './accounts-pane-minimax-actions'

export type AccountsPaneCredentialSections = {
  miniMax: MiniMaxCredentialSectionModel
  fireworks: FireworksCredentialSectionModel
}

type RecordFeatureInteraction = (featureId: FeatureInteractionId) => void

// Why: the bridge-backed credential sections share one shape — masked draft,
// configured flag, busy flag, save/clear over the preload bridge, and a
// mount-time status refresh. Owning that state here keeps AccountsPane composing
// sections instead of growing past its max-lines budget.
export function useAccountsPaneCredentialSections(
  recordFeatureInteraction: RecordFeatureInteraction
): AccountsPaneCredentialSections {
  const miniMax = useMiniMaxCredentials(recordFeatureInteraction)
  const fireworks = useFireworksCredentials(recordFeatureInteraction)
  return { miniMax, fireworks }
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
