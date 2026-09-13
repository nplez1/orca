import type { Dispatch, SetStateAction } from 'react'
import type { FeatureInteractionId } from '../../../../shared/feature-interaction-catalog'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

type FireworksCredentialActionContext = {
  fireworksApiKeyDraft: string
  fireworksApiKeyConfigured: boolean
  setFireworksApiKeyDraft: Dispatch<SetStateAction<string>>
  fireworksAccountIdDraft: string
  setFireworksAccountIdDraft: Dispatch<SetStateAction<string>>
  setFireworksApiKeyConfigured: Dispatch<SetStateAction<boolean>>
  setFireworksCredentialBusy: Dispatch<SetStateAction<boolean>>
  recordFeatureInteraction: (featureId: FeatureInteractionId) => void
}

export function createFireworksCredentialActions(context: FireworksCredentialActionContext): {
  saveFireworksCredentials: () => Promise<void>
  clearFireworksCredentials: () => Promise<void>
} {
  const {
    fireworksApiKeyDraft,
    fireworksApiKeyConfigured,
    setFireworksApiKeyDraft,
    fireworksAccountIdDraft,
    setFireworksAccountIdDraft,
    setFireworksApiKeyConfigured,
    setFireworksCredentialBusy,
    recordFeatureInteraction
  } = context

  const saveFireworksCredentials = async (): Promise<void> => {
    const apiKey = fireworksApiKeyDraft.trim()
    // Why: a blank key is only an error when there is nothing stored to keep —
    // otherwise it is how the account-ID override gets edited on its own.
    if (!apiKey && !fireworksApiKeyConfigured) {
      toast.error(
        translate(
          'auto.components.settings.accounts.pane.fireworks.actions.ee4388904a',
          'Fireworks API key is required.'
        )
      )
      return
    }
    // Why: an empty override must persist as null so main keeps auto-discovery.
    const accountIdOverride = fireworksAccountIdDraft.trim() || null
    setFireworksCredentialBusy(true)
    try {
      // Why: main persists both values and fires the fire-and-forget spend refresh.
      const status = await window.api.fireworksCredentials.save(apiKey, accountIdOverride)
      if (!status.apiKeyConfigured) {
        throw new Error('Fireworks API key was not saved.')
      }
      setFireworksApiKeyConfigured(status.apiKeyConfigured)
      setFireworksApiKeyDraft('')
      // Why: echo main's normalized override (trimmed, or null) back into the field.
      setFireworksAccountIdDraft(status.accountIdOverride ?? '')
      recordFeatureInteraction('usage-tracking')
      toast.success(
        translate(
          'auto.components.settings.accounts.pane.fireworks.actions.f2c3ea1168',
          'Fireworks credentials saved.'
        )
      )
    } catch (error) {
      toast.error(
        translate(
          'auto.components.settings.accounts.pane.fireworks.actions.54af23897c',
          'Fireworks credential update failed.'
        ),
        {
          description: error instanceof Error ? error.message : String(error)
        }
      )
    } finally {
      setFireworksCredentialBusy(false)
    }
  }

  const clearFireworksCredentials = async (): Promise<void> => {
    setFireworksCredentialBusy(true)
    try {
      const status = await window.api.fireworksCredentials.clear()
      setFireworksApiKeyConfigured(status.apiKeyConfigured)
      setFireworksApiKeyDraft('')
      setFireworksAccountIdDraft('')
      recordFeatureInteraction('usage-tracking')
    } catch (error) {
      toast.error(
        translate(
          'auto.components.settings.accounts.pane.fireworks.actions.54af23897c',
          'Fireworks credential update failed.'
        ),
        {
          description: error instanceof Error ? error.message : String(error)
        }
      )
    } finally {
      setFireworksCredentialBusy(false)
    }
  }

  return { saveFireworksCredentials, clearFireworksCredentials }
}
