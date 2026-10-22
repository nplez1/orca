import type {
  JiraCreateField,
  JiraCreateFieldAllowedValue,
  JiraFieldErrors,
  JiraTransition
} from './jira-types'

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
  if (isResolutionField(field) || isCommentField(field)) {
    return false
  }
  // Why both: `hasCurrentValue` covers a shape no control can seed from, and
  // `currentValue` is what a host from before that flag sends.
  return field.hasCurrentValue === true || Boolean(field.currentValue?.trim())
}

export function requiredTransitionFields(
  transition: JiraTransition,
  /** Fields Jira rejected by name, asked for again even though they look filled. */
  forcedFieldKeys?: ReadonlySet<string>
): JiraCreateField[] {
  // Why: a field Jira will default itself is not input the user owes us; prompting
  // for it turns a valid move into a blocked one.
  return (transition.fields ?? []).filter(
    (field) =>
      field.required &&
      field.hasDefaultValue !== true &&
      (forcedFieldKeys?.has(field.key) === true || !issueFillsField(field))
  )
}

/**
 * The fields a rejection names, so a skipped field can be asked for again instead
 * of dead-ending on a value Orca will not touch. A value that went stale, or a
 * validator that demands the field be set on this transition, both arrive here
 * rather than as a sentence with nowhere to act on it.
 */
export function rejectedTransitionFieldKeys(
  transition: JiraTransition,
  fieldErrors: JiraFieldErrors | undefined
): ReadonlySet<string> {
  const rejected = new Set(Object.keys(fieldErrors ?? {}))
  const forced = new Set<string>()
  for (const field of transition.fields ?? []) {
    if (rejected.has(field.key)) {
      forced.add(field.key)
    }
  }
  return forced
}

export function classifyTransitionRequirements(
  transition: JiraTransition,
  forcedFieldKeys?: ReadonlySet<string>
): JiraTransitionRequirement {
  const required = requiredTransitionFields(transition, forcedFieldKeys)
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
