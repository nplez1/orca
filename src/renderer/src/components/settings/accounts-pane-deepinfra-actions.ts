import type { Dispatch, SetStateAction } from 'react'
import type { FeatureInteractionId } from '../../../../shared/feature-interaction-catalog'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

type DeepInfraCredentialActionContext = {
  deepInfraApiKeyDraft: string
  setDeepInfraApiKeyDraft: Dispatch<SetStateAction<string>>
  setDeepInfraApiKeyConfigured: Dispatch<SetStateAction<boolean>>
  setDeepInfraCredentialBusy: Dispatch<SetStateAction<boolean>>
  recordFeatureInteraction: (featureId: FeatureInteractionId) => void
}

export function createDeepInfraCredentialActions(context: DeepInfraCredentialActionContext): {
  saveDeepInfraApiKey: () => Promise<void>
  clearDeepInfraApiKey: () => Promise<void>
} {
  const {
    deepInfraApiKeyDraft,
    setDeepInfraApiKeyDraft,
    setDeepInfraApiKeyConfigured,
    setDeepInfraCredentialBusy,
    recordFeatureInteraction
  } = context

  const saveDeepInfraApiKey = async (): Promise<void> => {
    if (!deepInfraApiKeyDraft.trim()) {
      toast.error(
        translate(
          'auto.components.settings.accounts.pane.deepinfra.actions.c63453203e',
          'DeepInfra API key is required.'
        )
      )
      return
    }
    setDeepInfraCredentialBusy(true)
    try {
      // Why: main persists the key and fires the fire-and-forget balance refresh.
      const status = await window.api.deepinfraCredentials.saveApiKey(deepInfraApiKeyDraft.trim())
      if (!status.apiKeyConfigured) {
        throw new Error('DeepInfra API key was not saved.')
      }
      setDeepInfraApiKeyConfigured(status.apiKeyConfigured)
      setDeepInfraApiKeyDraft('')
      recordFeatureInteraction('usage-tracking')
      toast.success(
        translate(
          'auto.components.settings.accounts.pane.deepinfra.actions.0db9f838a9',
          'DeepInfra API key saved.'
        )
      )
    } catch (error) {
      toast.error(
        translate(
          'auto.components.settings.accounts.pane.deepinfra.actions.ecab36fd1d',
          'DeepInfra credential update failed.'
        ),
        {
          description: error instanceof Error ? error.message : String(error)
        }
      )
    } finally {
      setDeepInfraCredentialBusy(false)
    }
  }

  const clearDeepInfraApiKey = async (): Promise<void> => {
    setDeepInfraCredentialBusy(true)
    try {
      const status = await window.api.deepinfraCredentials.clearApiKey()
      setDeepInfraApiKeyConfigured(status.apiKeyConfigured)
      setDeepInfraApiKeyDraft('')
      recordFeatureInteraction('usage-tracking')
    } catch (error) {
      toast.error(
        translate(
          'auto.components.settings.accounts.pane.deepinfra.actions.ecab36fd1d',
          'DeepInfra credential update failed.'
        ),
        {
          description: error instanceof Error ? error.message : String(error)
        }
      )
    } finally {
      setDeepInfraCredentialBusy(false)
    }
  }

  return { saveDeepInfraApiKey, clearDeepInfraApiKey }
}
