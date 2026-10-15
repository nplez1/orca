import type { JiraCreateField } from './jira-types'

/** The control Orca renders for a Jira field's schema. */
export type JiraFieldControlKind =
  | 'user'
  | 'userList'
  | 'select'
  | 'textList'
  | 'textarea'
  | 'date'
  | 'number'
  | 'text'

/**
 * The control a field's schema maps to, or null when Orca has no control that
 * would submit the shape Jira expects. Shared by the create dialog, the edit
 * form, and the transition-fields form so all three agree on what is editable;
 * a field Orca cannot render must be named back to the user, not guessed at.
 */
export function resolveJiraFieldControlKind(field: JiraCreateField): JiraFieldControlKind | null {
  const type = field.schema?.type
  const items = field.schema?.items
  const custom = field.schema?.custom ?? ''
  const hasOptions = Boolean(field.allowedValues?.length)
  if (type === 'user') {
    return 'user'
  }
  if (type === 'array' && items === 'user') {
    return 'userList'
  }
  if (type === 'array' && (items === 'string' || (items === 'option' && hasOptions))) {
    return 'textList'
  }
  if (type === 'array') {
    return null
  }
  if (type === 'option') {
    return hasOptions ? 'select' : null
  }
  if (hasOptions) {
    return 'select'
  }
  if (custom.includes(':textarea') || type === 'textarea') {
    return 'textarea'
  }
  if (type === 'date' || type === 'datetime') {
    return 'date'
  }
  if (type === 'number') {
    return 'number'
  }
  return type === 'string' ? 'text' : null
}

/** True for single- and multi-user fields, which need an accountId/id, not a name. */
export function isJiraUserField(field: JiraCreateField): boolean {
  const kind = resolveJiraFieldControlKind(field)
  return kind === 'user' || kind === 'userList'
}
