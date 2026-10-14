import type { JiraIssueUpdate } from '../../shared/jira-types'

function normalizeStringArray(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined
  }
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : undefined
}

/** True for a plain object payload (not an array), the shape Jira's `fields` take. */
function isRecordPayload(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** Custom-field edits may only name custom fields; the system fields the row edits
 *  have dedicated update fields, and the transition screen is the one place a
 *  workflow publicly names system fields. */
function isCustomFieldMap(value: Record<string, unknown>): boolean {
  return Object.keys(value).every((key) => key.startsWith('customfield_'))
}

/** Narrows an untrusted IPC payload to the issue-update fields the host accepts. */
export function normalizeIssueUpdate(value: unknown): JiraIssueUpdate | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every field is re-checked below before the narrowed object is returned.
  const input = value as JiraIssueUpdate
  if (input.title !== undefined && typeof input.title !== 'string') {
    return null
  }
  if (input.labels !== undefined && normalizeStringArray(input.labels) === undefined) {
    return null
  }
  if (
    input.assigneeAccountId !== undefined &&
    input.assigneeAccountId !== null &&
    typeof input.assigneeAccountId !== 'string'
  ) {
    return null
  }
  if (
    input.priorityId !== undefined &&
    input.priorityId !== null &&
    typeof input.priorityId !== 'string'
  ) {
    return null
  }
  if (input.transitionId !== undefined && typeof input.transitionId !== 'string') {
    return null
  }
  // A blank id is malformed rather than a clear: an unset sprint is null, and reading
  // "" as the backlog would silently move the issue out of its sprint.
  if (
    input.sprintId !== undefined &&
    input.sprintId !== null &&
    (typeof input.sprintId !== 'string' || !input.sprintId.trim())
  ) {
    return null
  }
  if (
    input.customFields !== undefined &&
    (!isRecordPayload(input.customFields) || !isCustomFieldMap(input.customFields))
  ) {
    return null
  }
  if (input.transitionFields !== undefined && !isRecordPayload(input.transitionFields)) {
    return null
  }
  if (
    input.userFieldKeys !== undefined &&
    normalizeStringArray(input.userFieldKeys) === undefined
  ) {
    return null
  }
  if (
    input.transitionUserFieldKeys !== undefined &&
    normalizeStringArray(input.transitionUserFieldKeys) === undefined
  ) {
    return null
  }
  if (
    input.textFieldKeys !== undefined &&
    normalizeStringArray(input.textFieldKeys) === undefined
  ) {
    return null
  }
  if (
    input.transitionTextFieldKeys !== undefined &&
    normalizeStringArray(input.transitionTextFieldKeys) === undefined
  ) {
    return null
  }
  return input
}
