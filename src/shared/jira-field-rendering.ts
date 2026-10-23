import type { JiraCreateField } from './jira-types'

const STORY_POINTS_CUSTOM_TYPE = 'com.pyxis.greenhopper.jira:jsw-story-points'
const NUMBER_CUSTOM_TYPE = 'com.atlassian.jira.plugin.system.customfieldtypes:float'

/**
 * The project-scoped reference lists Jira reports as `array/items: string` even though
 * every entry the issue holds is an object. Components, versions and fixVersions are
 * the whole set: a bare string is rejected for them, so each entry has to be submitted
 * as a reference and the site's own project list is the only place its ids come from.
 * `versions` and `fixVersions` read the same project list, so one kind covers both.
 */
export type JiraObjectListFieldKind = 'components' | 'versions'

const JIRA_OBJECT_LIST_SYSTEM_FIELDS = new Map<string, JiraObjectListFieldKind>([
  ['components', 'components'],
  ['versions', 'versions'],
  ['fixVersions', 'versions']
])

/**
 * Which project list a field needs, or null when its value is genuinely a string list
 * (labels, Team). Read from `schema.system`, falling back to the field key because a
 * custom field carries `custom` instead and these three system keys are stable across
 * Cloud and Server/DC.
 */
export function resolveJiraObjectListFieldKind(
  field: JiraCreateField
): JiraObjectListFieldKind | null {
  if (field.schema?.type !== 'array') {
    return null
  }
  const system = field.schema.system || (field.schema.custom ? '' : field.key)
  return JIRA_OBJECT_LIST_SYSTEM_FIELDS.get(system) ?? null
}

/** The control Orca renders for a Jira field's schema. */
export type JiraFieldControlKind =
  | 'user'
  | 'userList'
  | 'select'
  | 'optionList'
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
  const objectListKind = resolveJiraObjectListFieldKind(field)
  if (type === 'user') {
    return 'user'
  }
  if (type === 'array' && items === 'user') {
    return 'userList'
  }
  // Why before the `items` branches: Jira reports these three as `items: string` on some
  // sites and `items: component`/`items: version` on others, so the reference shape — not
  // the item type — is what decides the control.
  if (objectListKind !== null) {
    return hasOptions ? 'optionList' : 'textList'
  }
  if (type === 'array' && items === 'string') {
    return 'textList'
  }
  // An option list holds ids it must submit back, so it gets a control that can
  // name the options rather than a text box that would show the ids themselves.
  if (type === 'array' && items === 'option' && hasOptions) {
    return 'optionList'
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
