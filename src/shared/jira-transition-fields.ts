import type { JiraCreateField, JiraCreateFieldAllowedValue, JiraTransition } from './jira-types'

export type JiraTransitionRequirement =
  | { kind: 'none' }
  | {
      kind: 'form'
      resolution: JiraCreateField | null
      commentRequired: boolean
      /** Everything else the screen requires and the issue does not already fill. */
      fields: JiraCreateField[]
    }

function isResolutionField(field: JiraCreateField): boolean {
  return field.key === 'resolution' && !field.schema?.custom
}

function isCommentField(field: JiraCreateField): boolean {
  return field.key === 'comment' && !field.schema?.custom
}

/**
 * Why: Jira flags a field required by the transition's screen, not by this
 * issue's emptiness, so a field the issue already fills is not input the user
 * owes — asking for it turns a move Jira would accept into a blocked one.
 * Resolution and the comment are exempt: a workflow can demand the user set
 * them on this transition even when a value already exists.
 */
function issueFillsField(field: JiraCreateField): boolean {
  return !isResolutionField(field) && !isCommentField(field) && Boolean(field.currentValue?.trim())
}

export function requiredTransitionFields(transition: JiraTransition): JiraCreateField[] {
  // Why: a field Jira will default itself is not input the user owes us; prompting
  // for it turns a valid move into a blocked one.
  return (transition.fields ?? []).filter(
    (field) => field.required && field.hasDefaultValue !== true && !issueFillsField(field)
  )
}

export function classifyTransitionRequirements(
  transition: JiraTransition
): JiraTransitionRequirement {
  const required = requiredTransitionFields(transition)
  if (required.length === 0) {
    return { kind: 'none' }
  }

  let resolution: JiraCreateField | null = null
  let commentRequired = false
  const fields: JiraCreateField[] = []
  const seen = new Set<string>()

  for (const field of required) {
    // Why: Jira can list one field twice; one control holds it, and asking twice
    // would submit the same key and lose whichever value the user typed second.
    if (seen.has(field.key)) {
      continue
    }
    seen.add(field.key)
    if (
      isResolutionField(field) &&
      field.allowedValues?.some((value) => transitionAllowedValueKey(value))
    ) {
      resolution = field
      continue
    }
    if (isCommentField(field)) {
      commentRequired = true
      continue
    }
    fields.push(field)
  }

  return { kind: 'form', resolution, commentRequired, fields }
}

export function transitionAllowedValueLabel(value: JiraCreateFieldAllowedValue): string {
  return value.name ?? value.value ?? value.id ?? 'Option'
}

/** Stable select value / draft key — keep in sync with option `value` and draft seed. */
export function transitionAllowedValueKey(value: JiraCreateFieldAllowedValue): string {
  return value.id?.trim() || value.value?.trim() || value.name?.trim() || ''
}

export function buildResolutionFieldValue(
  field: JiraCreateField,
  selectedId: string
): Record<string, string> | null {
  const trimmed = selectedId.trim()
  if (!trimmed) {
    return null
  }
  const match = field.allowedValues?.find((value) => transitionAllowedValueKey(value) === trimmed)
  if (match?.id?.trim()) {
    return { id: match.id.trim() }
  }
  if (match?.name?.trim()) {
    return { name: match.name.trim() }
  }
  if (match?.value?.trim()) {
    return { value: match.value.trim() }
  }
  return null
}
