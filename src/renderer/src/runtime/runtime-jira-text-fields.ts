import { buildJiraCreateTextAdf } from '@/components/jira-create-adf'
import { JIRA_TEXT_FIELDS_RUNTIME_CAPABILITY } from '../../../shared/jira-runtime-capabilities'
import type { JiraIssueUpdate } from '../../../shared/jira/jira-types'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { jiraCapabilityProbeForTarget, type JiraCapabilityProbe } from './jira-capability-probe'

export type JiraTextFields = {
  values?: Record<string, unknown>
  textFieldKeys?: string[]
}

/**
 * Shapes textarea values for the host that will carry them. A host that knows
 * `jira.text-fields.v1` converts plain text to the site's own body format (v2
 * wants wiki text, v3 ADF); a host from before it would pass the plain value
 * straight to v3 and be rejected, so the renderer sends the ADF it used to.
 */
export async function foldTextFieldsForCapabilities(
  supports: JiraCapabilityProbe,
  values: Record<string, unknown> | undefined,
  textFieldKeys: readonly string[] | undefined
): Promise<JiraTextFields> {
  if (!values || !textFieldKeys || textFieldKeys.length === 0) {
    return { values, textFieldKeys: textFieldKeys ? [...textFieldKeys] : undefined }
  }
  if (await supports(JIRA_TEXT_FIELDS_RUNTIME_CAPABILITY)) {
    return { values, textFieldKeys: [...textFieldKeys] }
  }
  const folded = { ...values }
  for (const key of textFieldKeys) {
    const value = folded[key]
    if (typeof value === 'string' && value.trim()) {
      folded[key] = buildJiraCreateTextAdf(value)
    }
  }
  return { values: folded, textFieldKeys: undefined }
}

export async function foldTextFieldsForTarget(
  target: RuntimeClientTarget,
  values: Record<string, unknown> | undefined,
  textFieldKeys: readonly string[] | undefined
): Promise<JiraTextFields> {
  return foldTextFieldsForCapabilities(jiraCapabilityProbeForTarget(target), values, textFieldKeys)
}

/** Shapes both textarea payloads an update can carry for the host that will run it. */
export async function foldIssueUpdateForCapabilities(
  supports: JiraCapabilityProbe,
  updates: JiraIssueUpdate
): Promise<JiraIssueUpdate> {
  const fields = updates.customFields
    ? await foldTextFieldsForCapabilities(supports, updates.customFields, updates.textFieldKeys)
    : null
  const transition = updates.transitionFields
    ? await foldTextFieldsForCapabilities(
        supports,
        updates.transitionFields,
        updates.transitionTextFieldKeys
      )
    : null
  if (!fields && !transition) {
    return updates
  }
  return {
    ...updates,
    ...(fields ? { customFields: fields.values, textFieldKeys: fields.textFieldKeys } : {}),
    ...(transition
      ? { transitionFields: transition.values, transitionTextFieldKeys: transition.textFieldKeys }
      : {})
  }
}

export async function foldIssueUpdateForTarget(
  target: RuntimeClientTarget,
  updates: JiraIssueUpdate
): Promise<JiraIssueUpdate> {
  return foldIssueUpdateForCapabilities(jiraCapabilityProbeForTarget(target), updates)
}
