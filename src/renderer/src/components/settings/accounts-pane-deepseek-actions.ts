import type { Dispatch, SetStateAction } from 'react'
import type { FeatureInteractionId } from '../../../../shared/feature-interaction-catalog'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

type DeepSeekCredentialActionContext = {
  deepSeekApiKeyDraft: string
  setDeepSeekApiKeyDraft: Dispatch<SetStateAction<string>>
  setDeepSeekApiKeyConfigured: Dispatch<SetStateAction<boolean>>
  setDeepSeekCredentialBusy: Dispatch<SetStateAction<boolean>>
  recordFeatureInteraction: (featureId: FeatureInteractionId) => void
}

export function createDeepSeekCredentialActions(context: DeepSeekCredentialActionContext): {
  saveDeepSeekApiKey: () => Promise<void>
  clearDeepSeekApiKey: () => Promise<void>
} {
  const {
    deepSeekApiKeyDraft,
    setDeepSeekApiKeyDraft,
    setDeepSeekApiKeyConfigured,
    setDeepSeekCredentialBusy,
    recordFeatureInteraction
  } = context

  const saveDeepSeekApiKey = async (): Promise<void> => {
    if (!deepSeekApiKeyDraft.trim()) {
      toast.error(
        translate(
          'auto.components.settings.accounts.pane.deepseek.actions.312f213d4f',
          'DeepSeek API key is required.'
        )
      )
      return
    }
    setDeepSeekCredentialBusy(true)
    try {
      // Why: main persists the key and fires the fire-and-forget balance refresh.
      const status = await window.api.deepseekCredentials.saveApiKey(deepSeekApiKeyDraft.trim())
      if (!status.apiKeyConfigured) {
        throw new Error('DeepSeek API key was not saved.')
      }
      setDeepSeekApiKeyConfigured(status.apiKeyConfigured)
      setDeepSeekApiKeyDraft('')
      recordFeatureInteraction('usage-tracking')
      toast.success(
        translate(
          'auto.components.settings.accounts.pane.deepseek.actions.e77c0b006a',
          'DeepSeek API key saved.'
        )
      )
    } catch (error) {
      toast.error(
        translate(
          'auto.components.settings.accounts.pane.deepseek.actions.82ad607eeb',
          'DeepSeek credential update failed.'
        ),
        {
          description: error instanceof Error ? error.message : String(error)
        }
      )
    } finally {
      setDeepSeekCredentialBusy(false)
    }
  }

  const clearDeepSeekApiKey = async (): Promise<void> => {
    setDeepSeekCredentialBusy(true)
    try {
      const status = await window.api.deepseekCredentials.clearApiKey()
      setDeepSeekApiKeyConfigured(status.apiKeyConfigured)
      setDeepSeekApiKeyDraft('')
      recordFeatureInteraction('usage-tracking')
    } catch (error) {
      toast.error(
        translate(
          'auto.components.settings.accounts.pane.deepseek.actions.82ad607eeb',
          'DeepSeek credential update failed.'
        ),
        {
          description: error instanceof Error ? error.message : String(error)
        }
      )
    } finally {
      setDeepSeekCredentialBusy(false)
    }
  }

  return { saveDeepSeekApiKey, clearDeepSeekApiKey }
}
