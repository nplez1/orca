/** Jira capability names, split out of `protocol-version.ts`, which lists them in
 *  `RUNTIME_CAPABILITIES`. Import them from here. */
export const JIRA_USER_FIELDS_RUNTIME_CAPABILITY = 'jira.user-fields.v1' as const
export const JIRA_USER_FIELDS_UPDATE_REQUIRED_MESSAGE =
  'Creating Jira issues with user fields requires a newer Orca server. Update the server and try again.'
// Why: a host without this ignores the textFieldKeys the value shaping relies on,
// so a plain textarea value would reach Cloud and be rejected. The client falls
// back to the ADF shape those older hosts already handled.
export const JIRA_TEXT_FIELDS_RUNTIME_CAPABILITY = 'jira.text-fields.v1' as const

export const JIRA_RUNTIME_CAPABILITIES = [
  JIRA_USER_FIELDS_RUNTIME_CAPABILITY,
  JIRA_TEXT_FIELDS_RUNTIME_CAPABILITY
] as const
