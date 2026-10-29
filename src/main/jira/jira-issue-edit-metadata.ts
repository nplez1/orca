import {
  resolveJiraFieldControlKind,
  resolveJiraObjectListFieldKind
} from '../../shared/jira-field-rendering'
import type { JiraCreateField, JiraEditableField } from '../../shared/jira/jira-types'
import { acquire, release } from './request-queue'
import { apiBasePath, jiraRequest } from './authenticated-request'
import { clearToken, getClients, isAuthError } from './client'
import { requireStrictJiraSite } from './jira-read-failure'
import { describeFieldDraft } from './jira-field-drafts'
import { mapCreateField } from './jira-issue-mapping'
import { readProjectFieldOptions, withJiraProjectFieldOptions } from './jira-project-field-options'
import { asRecord, asString, type JiraRecord } from './jira-record-pages'

/** True when Jira lets this user write the field. Custom-field keys are the
 *  site-specific `customfield_NNNNN` ids; the summary, labels, assignee, and priority
 *  the detail view already edits inline are deliberately not offered here. The
 *  components/versions fields are the exception among system fields: they hold
 *  references no other surface writes, so with the project's own list behind them
 *  they belong here too. */
function isWritableField(field: JiraCreateField, meta: JiraRecord): boolean {
  const isCustomField = field.key.startsWith('customfield_')
  if (!isCustomField && resolveJiraObjectListFieldKind(field) === null) {
    return false
  }
  const operations = Array.isArray(meta.operations) ? meta.operations : null
  return !operations || operations.some((op) => op === 'set' || op === 'add')
}

/**
 * Fields this user can edit on one issue, each with the value the issue holds.
 * Reads `?expand=editmeta`, the edit-side sibling of the create metadata Orca
 * already reads, so the site's own field ids and required flags decide what is
 * offered rather than a hardcoded list. Returns `[]` when the read fails, unless
 * `strict` asks for the failure, which a surface that would otherwise render an
 * empty form needs in order to say the read failed instead.
 */
export async function listEditFields(
  key: string,
  siteId?: string | null,
  strict = false
): Promise<JiraEditableField[]> {
  const entries = getClients(siteId)
  requireStrictJiraSite(entries, siteId, strict)
  const entry = entries[0]
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
    const offered: { key: string; field: JiraCreateField }[] = []
    for (const [fieldKey, rawMeta] of Object.entries(meta)) {
      const metaRecord = asRecord(rawMeta)
      const field = mapCreateField(metaRecord, fieldKey)
      if (!field || !isWritableField(field, metaRecord)) {
        continue
      }
      offered.push({ key: fieldKey, field })
    }
    // Why before the control check and the draft: a components field has no allowedValues
    // of its own, so it is only renderable — and only drafts as the id Jira accepts —
    // once the project's list is attached. No project key means no list: guessing it from
    // the issue key would offer another project's components after the issue moved.
    const projectKey = asString(asRecord(values.project).key)
    const options = projectKey
      ? await readProjectFieldOptions(
          entry,
          projectKey,
          offered.map((candidate) => candidate.field)
        )
      : {}
    const editable: JiraEditableField[] = []
    for (const candidate of offered) {
      const field = withJiraProjectFieldOptions(candidate.field, options)
      if (resolveJiraFieldControlKind(field) === null) {
        continue
      }
      editable.push({ field, ...describeFieldDraft(field, values[candidate.key]) })
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
    if (strict) {
      throw error
    }
    return []
  } finally {
    release()
  }
}
