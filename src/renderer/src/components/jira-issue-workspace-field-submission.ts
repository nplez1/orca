import { jiraUpdateIssue } from '@/runtime/runtime-jira-client'
import type { RuntimeJiraSettings } from '@/runtime/runtime-jira-target'
import type { JiraFieldErrors, JiraIssue } from '../../../shared/jira/jira-types'
import { translate } from '@/i18n/i18n'

/** Applies a custom-field edit and reports Jira's own rejection reasons back to
 *  the calling form instead of swallowing them into a toast. Split out of the
 *  detail hook to stay within the file line cap. */
export async function submitJiraIssueFields({
  displayed,
  pendingField,
  providerSettings,
  siteId,
  refreshIssue,
  reloadEditFields,
  setPendingField,
  updates
}: {
  displayed: JiraIssue | null
  pendingField: string | null
  providerSettings: RuntimeJiraSettings
  siteId: string | undefined
  refreshIssue: () => Promise<void>
  reloadEditFields: () => Promise<void>
  setPendingField: (field: string | null) => void
  updates: Parameters<typeof jiraUpdateIssue>[2]
}): Promise<{ ok: true } | { ok: false; error: string; fieldErrors?: JiraFieldErrors }> {
  if (!displayed) {
    return {
      ok: false,
      error: translate(
        'auto.components.JiraIssueWorkspace.noIssueSelected',
        'No Jira issue is selected.'
      )
    }
  }
  if (pendingField) {
    return {
      ok: false,
      error: translate(
        'auto.components.JiraIssueWorkspace.anotherUpdatePending',
        'Another Jira update is still in progress.'
      )
    }
  }
  setPendingField('fields')
  try {
    const result = await jiraUpdateIssue(providerSettings, displayed.key, updates, siteId)
    if (!result.ok) {
      return {
        ok: false,
        error: result.error,
        ...(result.fieldErrors ? { fieldErrors: result.fieldErrors } : {})
      }
    }
    await refreshIssue()
    await reloadEditFields()
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : translate(
              'auto.components.JiraIssueWorkspace.ea21952aa3',
              'Failed to update Jira issue.'
            )
    }
  } finally {
    setPendingField(null)
  }
}
