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

/** Narrows an untrusted IPC payload to the issue-update fields the host accepts. */
export function normalizeIssueUpdate(value: unknown): JiraIssueUpdate | null {
  if (!value || typeof value !== 'object') {
    return null
  }
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
  if (input.customFields !== undefined && !isRecordPayload(input.customFields)) {
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
  return input
}
