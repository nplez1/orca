import type { Dispatch, SetStateAction } from 'react'
import type { FeatureInteractionId } from '../../../../shared/feature-interaction-catalog'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

type CopilotCredentialActionContext = {
  copilotTokenDraft: string
  copilotConfigured: boolean
  setCopilotTokenDraft: Dispatch<SetStateAction<string>>
  copilotEnterpriseSlugDraft: string
  setCopilotEnterpriseSlugDraft: Dispatch<SetStateAction<string>>
  setCopilotConfigured: Dispatch<SetStateAction<boolean>>
  setCopilotCredentialBusy: Dispatch<SetStateAction<boolean>>
  recordFeatureInteraction: (featureId: FeatureInteractionId) => void
}

export function createCopilotCredentialActions(context: CopilotCredentialActionContext): {
  saveCopilotCredentials: () => Promise<void>
  clearCopilotCredentials: () => Promise<void>
} {
  const {
    copilotTokenDraft,
    copilotConfigured,
    setCopilotTokenDraft,
    copilotEnterpriseSlugDraft,
    setCopilotEnterpriseSlugDraft,
    setCopilotConfigured,
    setCopilotCredentialBusy,
    recordFeatureInteraction
  } = context

  const saveCopilotCredentials = async (): Promise<void> => {
    const token = copilotTokenDraft.trim()
    // Why: a blank token is only an error when there is nothing stored to keep —
    // otherwise it is how the enterprise slug gets edited on its own.
    if (!token && !copilotConfigured) {
      toast.error(
        translate(
          'auto.components.settings.accounts.pane.copilot.actions.70efb28dee',
          'GitHub token is required.'
        )
      )
      return
    }
    setCopilotCredentialBusy(true)
    try {
      // Why: main persists both values and fires the fire-and-forget usage refresh.
      const status = await window.api.copilotCredentials.save(
        token,
        copilotEnterpriseSlugDraft.trim()
      )
      if (!status.configured) {
        throw new Error('GitHub Copilot credentials were not saved.')
      }
      setCopilotConfigured(status.configured)
      setCopilotTokenDraft('')
      // Why: echo main's normalized slug (trimmed) back into the field.
      setCopilotEnterpriseSlugDraft(status.enterpriseSlug ?? '')
      recordFeatureInteraction('usage-tracking')
      toast.success(
        translate(
          'auto.components.settings.accounts.pane.copilot.actions.1d08d465f5',
          'GitHub Copilot credentials saved.'
        )
      )
    } catch (error) {
      toast.error(
        translate(
          'auto.components.settings.accounts.pane.copilot.actions.41c1907a73',
          'GitHub Copilot credential update failed.'
        ),
        {
          description: error instanceof Error ? error.message : String(error)
        }
      )
    } finally {
      setCopilotCredentialBusy(false)
    }
  }

  const clearCopilotCredentials = async (): Promise<void> => {
    setCopilotCredentialBusy(true)
    try {
      const status = await window.api.copilotCredentials.clear()
      setCopilotConfigured(status.configured)
      setCopilotTokenDraft('')
      setCopilotEnterpriseSlugDraft('')
      recordFeatureInteraction('usage-tracking')
    } catch (error) {
      toast.error(
        translate(
          'auto.components.settings.accounts.pane.copilot.actions.41c1907a73',
          'GitHub Copilot credential update failed.'
        ),
        {
          description: error instanceof Error ? error.message : String(error)
        }
      )
    } finally {
      setCopilotCredentialBusy(false)
    }
  }

  return { saveCopilotCredentials, clearCopilotCredentials }
}
