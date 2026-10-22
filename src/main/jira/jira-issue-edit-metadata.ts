import { resolveJiraFieldControlKind } from '../../shared/jira-field-rendering'
import type { JiraCreateField, JiraEditableField } from '../../shared/jira-types'
import { acquire, release } from './request-queue'
import { apiBasePath, jiraRequest } from './authenticated-request'
import { clearToken, getClients, isAuthError } from './client'
import { describeFieldDraft } from './jira-field-drafts'
import { mapCreateField } from './jira-issue-mapping'
import { asRecord, type JiraRecord } from './jira-record-pages'

/** True when Jira lets this user write the field and Orca can render its shape.
 *  Custom-field keys are the site-specific `customfield_NNNNN` ids; the summary,
 *  labels, assignee, and priority the detail view already edits inline are
 *  deliberately not offered here. */
function isEditableCustomField(field: JiraCreateField, meta: JiraRecord): boolean {
  if (!field.key.startsWith('customfield_')) {
    return false
  }
  const operations = Array.isArray(meta.operations) ? meta.operations : null
  if (operations && !operations.some((op) => op === 'set' || op === 'add')) {
    return false
  }
  return resolveJiraFieldControlKind(field) !== null
}

/**
 * Fields this user can edit on one issue, each with the value the issue holds.
 * Reads `?expand=editmeta`, the edit-side sibling of the create metadata Orca
 * already reads, so the site's own field ids and required flags decide what is
 * offered rather than a hardcoded list. Returns `[]` when the read fails.
 */
export async function listEditFields(
  key: string,
  siteId?: string | null
): Promise<JiraEditableField[]> {
  const entry = getClients(siteId)[0]
  if (!entry) {
    return []
  }
  await acquire()
  try {
    const params = new URLSearchParams({ expand: 'editmeta' })
    const response = await jiraRequest<JiraRecord>(
      entry,
      `${apiBasePath(entry.site)}/issue/${encodeURIComponent(key)}?${params.toString()}`
    )
    const values = asRecord(response.fields)
    const meta = asRecord(asRecord(response.editmeta).fields)
    const editable: JiraEditableField[] = []
    for (const [fieldKey, rawMeta] of Object.entries(meta)) {
      const metaRecord = asRecord(rawMeta)
      const field = mapCreateField(metaRecord, fieldKey)
      if (!field || !isEditableCustomField(field, metaRecord)) {
        continue
      }
      editable.push({ field, ...describeFieldDraft(field, values[fieldKey]) })
    }
    // Why: object key order follows the editmeta payload, which is not stable
    // across sites; a name-ordered form is the same form every time it opens.
    return editable.sort((left, right) => left.field.name.localeCompare(right.field.name))
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.site.id)
      throw error
    }
    console.warn('[jira] listEditFields failed:', error)
    return []
  } finally {
    release()
  }
}
