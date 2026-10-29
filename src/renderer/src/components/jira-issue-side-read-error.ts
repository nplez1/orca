import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { translate } from '@/i18n/i18n'

/** Each Jira issue side read has its own fallback, because the picker it feeds shows
 *  the message in place of its own empty state. */
export const TRANSITIONS_READ_FAILED = [
  'jira.issue.transitionsError',
  'Failed to load status changes.'
] as const
export const PRIORITIES_READ_FAILED = [
  'jira.issue.prioritiesError',
  'Failed to load the priorities this issue can be set to.'
] as const
export const USERS_READ_FAILED = [
  'jira.issue.assignableUsersError',
  'Failed to load the people assignable to this issue.'
] as const
export const EDIT_FIELDS_READ_FAILED = [
  'jira.issue.editFieldsError',
  'Failed to load the fields you can edit on this issue.'
] as const
export const SPRINT_READ_FAILED = [
  'jira.issue.sprintAssignmentError',
  'Failed to load this issue’s sprint.'
] as const

/** A read's failure as the user should read it: the IPC wrapper stripped, and the
 *  fallback translated rather than a bare English sentence. */
export function describeJiraSideReadFailure(error: unknown, key: string, fallback: string): string {
  return extractIpcErrorMessage(error, translate(key, fallback))
}
