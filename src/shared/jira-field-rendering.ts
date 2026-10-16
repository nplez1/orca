import type { JiraCreateField } from './jira-types'

const STORY_POINTS_CUSTOM_TYPE = 'com.pyxis.greenhopper.jira:jsw-story-points'
const NUMBER_CUSTOM_TYPE = 'com.atlassian.jira.plugin.system.customfieldtypes:float'

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
  if (type === 'date') {
    return 'date'
  }
  // Why not a date control: Jira's datetime fields take an offset-carrying value
  // that an <input type="date"> cannot show or submit, so they stay free text.
  if (type === 'datetime') {
    return 'text'
  }
  if (type === 'number') {
    return 'number'
  }
  return type === 'string' ? 'text' : null
}

/** True for fields whose value Jira expects as a body document, not a bare string. */
export function isJiraTextAreaField(field: JiraCreateField): boolean {
  return field.schema?.custom?.includes(':textarea') === true || field.schema?.type === 'textarea'
}

/**
 * Jira's story-points field, by the rule the host's field catalogue uses to
 * discover it: Greenhopper's own field type, or the float custom field a site
 * names "Story points". Team-managed sites name theirs in the site's language,
 * so the type is what identifies it there. Accepts a raw field-catalogue record
 * as well as a mapped `JiraCreateField`.
 */
export function isJiraStoryPointsField(field: {
  name?: string | undefined
  schema?: { custom?: string | undefined } | undefined
}): boolean {
  const custom = field.schema?.custom ?? ''
  return (
    custom === STORY_POINTS_CUSTOM_TYPE ||
    (custom === NUMBER_CUSTOM_TYPE && /story points?/i.test(field.name ?? ''))
  )
}

/** True for single- and multi-user fields, which need an accountId/id, not a name. */
export function isJiraUserField(field: JiraCreateField): boolean {
  const kind = resolveJiraFieldControlKind(field)
  return kind === 'user' || kind === 'userList'
}
