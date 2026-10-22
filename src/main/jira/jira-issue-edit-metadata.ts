import { resolveJiraFieldControlKind } from '../../shared/jira-field-rendering'
import { joinJiraFieldDraft } from '../../shared/jira-field-draft'
import type { JiraCreateField, JiraEditableField, JiraUser } from '../../shared/jira-types'
import { adfToMarkdownText } from './adf-markdown'
import { acquire, release } from './request-queue'
import { apiBasePath, jiraRequest } from './authenticated-request'
import { clearToken, getClients, isAuthError } from './client'
import { mapCreateField } from './jira-issue-mapping'
import { asRecord, asString, type JiraRecord } from './jira-record-pages'

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

/** The human-readable label for an option value, for a name-bearing hint beside a
 *  control that has to hold the id the submission needs. */
function optionLabel(value: unknown): string {
  const record = asRecord(value)
  return asString(record.name) || asString(record.value) || asString(record.id)
}

/** The token an option control should hold: whichever form the allowed-value
 *  list can match back on, falling back to the value the response carried. */
function optionDraft(field: JiraCreateField, value: unknown): string {
  // A string list's entries are the values themselves, not option records.
  if (typeof value === 'string') {
    return value.trim()
  }
  const record = asRecord(value)
  const id = asString(record.id)
  const optionValue = asString(record.value)
  const name = asString(record.name)
  const allowed = field.allowedValues ?? []
  if (id && allowed.some((entry) => entry.id === id)) {
    return id
  }
  if (optionValue && allowed.some((entry) => entry.value === optionValue)) {
    return optionValue
  }
  if (name && allowed.some((entry) => entry.name === name)) {
    return name
  }
  return optionValue || name || id
}

function userDraft(value: unknown): { id: string; displayName?: string } {
  const user = asRecord(value)
  const id = asString(user.accountId) || asString(user.name) || asString(user.key)
  const displayName = asString(user.displayName)
  return { id, ...(displayName ? { displayName } : {}) }
}

/** The person a held id names, with the id standing in for a name the site does not
 *  report: the picker has to show something, and the id is the only handle left. */
function heldUser(user: { id: string; displayName?: string }): JiraUser {
  return { accountId: user.id, displayName: user.displayName ?? user.id }
}

/** Renders the issue's current value into the draft the paired control holds. */
function describeEditableValue(
  field: JiraCreateField,
  raw: unknown
): Pick<JiraEditableField, 'value' | 'displayName' | 'users'> {
  const kind = resolveJiraFieldControlKind(field)
  if (kind === 'user') {
    const user = userDraft(raw)
    return { value: user.id, ...(user.displayName ? { displayName: user.displayName } : {}) }
  }
  if (kind === 'userList') {
    const entries = (Array.isArray(raw) ? raw : []).map(userDraft).filter((user) => user.id)
    const names = entries.map((user) => user.displayName).filter(Boolean)
    // The joined hint stays for a renderer that predates `users` and still renders the
    // text box; the picker here ignores it, naming each person from `users` instead.
    return {
      value: joinJiraFieldDraft(entries.map((user) => user.id)),
      ...(names.length > 0 ? { displayName: names.join(', ') } : {}),
      ...(entries.length > 0 ? { users: entries.map(heldUser) } : {})
    }
  }
  if (Array.isArray(raw)) {
    // The joined labels stay for a renderer that predates the option list control and still
    // draws the text box: there they are the only readable form of the value. A string
    // list's entries carry no label, so it gets none.
    const labels = raw.map(optionLabel).filter(Boolean)
    return {
      value: joinJiraFieldDraft(raw.map((entry) => optionDraft(field, entry)).filter(Boolean)),
      ...(labels.length > 0 ? { displayName: labels.join(', ') } : {})
    }
  }
  if (raw === null || raw === undefined) {
    return { value: '' }
  }
  if (kind === 'select') {
    return { value: optionDraft(field, raw) }
  }
  if (kind === 'textarea') {
    return { value: typeof raw === 'string' ? raw : adfToMarkdownText(raw) }
  }
  if (typeof raw === 'object') {
    // A scalar control cannot round-trip an object; leave it unset rather than
    // show a shape it would write back wrong.
    return { value: '' }
  }
  return { value: String(raw) }
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
      editable.push({ field, ...describeEditableValue(field, values[fieldKey]) })
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
