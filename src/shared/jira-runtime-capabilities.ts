/** Jira capability names, split out of `protocol-version.ts`, which lists them in
 *  `RUNTIME_CAPABILITIES`. Import them from here. Names declared beside the feature
 *  that advertises them are re-exported so one import path serves every Jira one. */
export {
  JIRA_USER_FIELDS_RUNTIME_CAPABILITY,
  JIRA_USER_FIELDS_UPDATE_REQUIRED_MESSAGE,
  JIRA_TRANSITION_FIELDS_RUNTIME_CAPABILITY,
  JIRA_CURRENT_SPRINT_RUNTIME_CAPABILITY
} from './jira/jira-detail-capabilities'
// Why: a host without this ignores the textFieldKeys the value shaping relies on,
// so a plain textarea value would reach Cloud and be rejected. The client falls
// back to the ADF shape those older hosts already handled.
export const JIRA_TEXT_FIELDS_RUNTIME_CAPABILITY = 'jira.text-fields.v1' as const

export const JIRA_RUNTIME_CAPABILITIES = [JIRA_TEXT_FIELDS_RUNTIME_CAPABILITY] as const
