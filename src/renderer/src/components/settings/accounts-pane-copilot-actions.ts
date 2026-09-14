import type { Dispatch, SetStateAction } from 'react'
import type { FeatureInteractionId } from '../../../../shared/feature-interaction-catalog'
import type { CopilotCredentialSource } from './accounts-pane-types'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

type CopilotCredentialActionContext = {
  copilotTokenDraft: string
  copilotCredentialSource: CopilotCredentialSource
  setCopilotTokenDraft: Dispatch<SetStateAction<string>>
  copilotEnterpriseSlugDraft: string
  setCopilotEnterpriseSlugDraft: Dispatch<SetStateAction<string>>
  setCopilotCredentialSource: Dispatch<SetStateAction<CopilotCredentialSource>>
  setCopilotGhSetupHint: Dispatch<SetStateAction<string | null>>
  setCopilotCredentialBusy: Dispatch<SetStateAction<boolean>>
  recordFeatureInteraction: (featureId: FeatureInteractionId) => void
}

export function createCopilotCredentialActions(context: CopilotCredentialActionContext): {
  saveCopilotCredentials: () => Promise<void>
  clearCopilotCredentials: () => Promise<void>
} {
  const {
    copilotTokenDraft,
    copilotCredentialSource,
    setCopilotTokenDraft,
    copilotEnterpriseSlugDraft,
    setCopilotEnterpriseSlugDraft,
    setCopilotCredentialSource,
    setCopilotGhSetupHint,
    setCopilotCredentialBusy,
    recordFeatureInteraction
  } = context

  const saveCopilotCredentials = async (): Promise<void> => {
    const token = copilotTokenDraft.trim()
    // Why: a blank token is only an error when there is no stored token to keep —
    // otherwise it is how the enterprise slug gets edited on its own. A credential
    // sourced from the GitHub CLI is not a stored one, so main cannot keep it.
    if (!token && copilotCredentialSource !== 'stored') {
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
      setCopilotCredentialSource(status.source)
      setCopilotGhSetupHint(status.ghSetupHint)
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
      setCopilotCredentialSource(status.source)
      setCopilotGhSetupHint(status.ghSetupHint)
      setCopilotTokenDraft('')
      // Why: forgetting the pasted token can leave the GitHub CLI supplying the
      // slug, so echo main's answer instead of blanking the field outright.
      setCopilotEnterpriseSlugDraft(status.enterpriseSlug ?? '')
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
