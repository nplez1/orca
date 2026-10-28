import type {
  JiraCreateField,
  JiraCreateFieldAllowedValue
} from '../../../../../shared/jira/jira-types'
import {
  isJiraTextAreaField,
  resolveJiraObjectListFieldKind
} from '../../../../../shared/jira-field-rendering'
import { splitJiraFieldDraft } from '../../../../../shared/jira-field-draft'

// 'assignee' is system here because the dialog renders a dedicated picker for it.
const JIRA_CREATE_SYSTEM_FIELD_KEYS = new Set([
  'project',
  'issuetype',
  'summary',
  'description',
  'assignee'
])

export const JIRA_ASSIGNEE_FIELD_KEY = 'assignee'

// Jira rejects fields absent from the create screen.
export function hasJiraAssigneeCreateField(fields: readonly JiraCreateField[]): boolean {
  return fields.some((field) => field.key === JIRA_ASSIGNEE_FIELD_KEY)
}

export function isVisibleJiraCreateField(field: JiraCreateField): boolean {
  return field.required && !JIRA_CREATE_SYSTEM_FIELD_KEYS.has(field.key)
}

/** User fields lack allowedValues; schema type distinguishes scalar/array users from free text. */
export function isJiraUserCreateField(field: JiraCreateField): boolean {
  return (
    field.schema?.type === 'user' ||
    (field.schema?.type === 'array' && field.schema?.items === 'user')
  )
}

/** The picker holds one user; user arrays retain the comma-separated text path until multi-user input is supported. */
export function isJiraScalarUserCreateField(field: JiraCreateField): boolean {
  return field.schema?.type === 'user'
}

/** Send user-field keys because the host cannot infer user IDs from string values. */
export function getJiraUserCreateFieldKeys(fields: readonly JiraCreateField[]): string[] {
  return fields.filter(isJiraUserCreateField).map((field) => field.key)
}

export function getJiraCreateAllowedValueLabel(
  value: NonNullable<JiraCreateField['allowedValues']>[number]
): string {
  return value.name ?? value.value ?? value.id ?? 'Option'
}

export function findJiraCreateAllowedValue(
  field: { allowedValues?: readonly JiraCreateFieldAllowedValue[] | undefined },
  draftValue: string
) {
  return field.allowedValues?.find((value) => {
    return value.id === draftValue || value.value === draftValue || value.name === draftValue
  })
}

export function getJiraCreateOptionPayload(
  value: NonNullable<JiraCreateField['allowedValues']>[number] | undefined,
  fallback: string
): Record<string, string> | string {
  if (value?.id) {
    return { id: value.id }
  }
  if (value?.value) {
    return { value: value.value }
  }
  if (value?.name) {
    return { name: value.name }
  }
  return fallback
}

export function buildJiraCreateFieldValue(field: JiraCreateField, draftValue: string): unknown {
  const trimmed = draftValue.trim()
  if (!trimmed) {
    return undefined
  }
  if (isJiraScalarUserCreateField(field)) {
    return trimmed
  }
  if (field.schema?.type === 'array') {
    const parts = splitJiraFieldDraft(trimmed)
    // Why references for these: components and versions say `items: string` but Jira
    // holds an object per entry and rejects a bare string, so each part goes in as a
    // reference — the id when the project's list names it, the name otherwise.
    if (resolveJiraObjectListFieldKind(field) !== null) {
      return parts.map((part) => {
        const option = findJiraCreateAllowedValue(field, part)
        return option?.id ? { id: option.id } : { name: part }
      })
    }
    if (field.allowedValues?.length) {
      return parts.map((part) =>
        getJiraCreateOptionPayload(findJiraCreateAllowedValue(field, part), part)
      )
    }
    return parts
  }
  if (field.allowedValues?.length) {
    return getJiraCreateOptionPayload(findJiraCreateAllowedValue(field, trimmed), trimmed)
  }
  if (field.schema?.type === 'number') {
    const numberValue = Number(trimmed)
    return Number.isFinite(numberValue) ? numberValue : trimmed
  }
  // The host converts textarea values to the site's own body format; a
  // renderer-built ADF document is rejected by Server/DC and flattens Markdown on Cloud.
  return trimmed
}

export function buildJiraCreateCustomFields(
  fields: readonly JiraCreateField[],
  values: Record<string, string>
): Record<string, unknown> | undefined {
  const customFields: Record<string, unknown> = {}
  for (const field of fields) {
    const value = buildJiraCreateFieldValue(field, values[field.key] ?? '')
    if (value !== undefined) {
      customFields[field.key] = value
    }
  }
  return Object.keys(customFields).length > 0 ? customFields : undefined
}

// Only populated user fields require the remote user-field capability.
export type JiraCreateFieldSubmission = {
  customFields?: Record<string, unknown>
  userFieldKeys?: string[]
  textFieldKeys?: string[]
}

export function buildJiraCreateSubmission(
  fields: readonly JiraCreateField[],
  values: Record<string, string>,
  assigneeAccountId?: string | null
): JiraCreateFieldSubmission {
  const customFields = { ...buildJiraCreateCustomFields(fields, values) }
  if (assigneeAccountId) {
    customFields[JIRA_ASSIGNEE_FIELD_KEY] = assigneeAccountId
  }
  const userFieldKeys = getJiraUserCreateFieldKeys(fields).filter(
    (key) => customFields[key] !== undefined
  )
  if (assigneeAccountId) {
    userFieldKeys.push(JIRA_ASSIGNEE_FIELD_KEY)
  }
  const textFieldKeys = fields
    .filter((field) => isJiraTextAreaField(field) && customFields[field.key] !== undefined)
    .map((field) => field.key)
  return {
    customFields: Object.keys(customFields).length > 0 ? customFields : undefined,
    userFieldKeys: userFieldKeys.length > 0 ? userFieldKeys : undefined,
    textFieldKeys: textFieldKeys.length > 0 ? textFieldKeys : undefined
  }
}
