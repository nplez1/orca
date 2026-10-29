import type { JiraCreateField, JiraCreateFieldAllowedValue } from '../../shared/jira/jira-types'
import {
  resolveJiraObjectListFieldKind,
  type JiraObjectListFieldKind
} from '../../shared/jira-field-rendering'
import { apiBasePath, jiraRequest, type JiraClientForSite } from './authenticated-request'
import { recordSwallowedFailure } from '../observability/swallowed-failure'
import { clearToken, isAuthError } from './client'
import { mapCreateFieldAllowedValue } from './jira-issue-mapping'
import { asRecord, asString, type JiraRecord } from './jira-record-pages'

/**
 * A project's own reference lists, keyed by the field kind that needs them.
 * Components and versions live outside `createmeta`/`editmeta`: neither supplies
 * `allowedValues` for those fields, so the project resource is the only place the
 * ids a `components`/`versions`/`fixVersions` entry has to carry come from.
 */
export type JiraProjectFieldOptions = Partial<
  Record<JiraObjectListFieldKind, JiraCreateFieldAllowedValue[]>
>

const PROJECT_LIST_PATHS: Record<JiraObjectListFieldKind, string> = {
  components: 'components',
  versions: 'versions'
}

/** True when a field needs its project's list: a reference-holding system field that
 *  Jira supplied no values for. */
export function needsProjectFieldOptions(field: JiraCreateField): boolean {
  return resolveJiraObjectListFieldKind(field) !== null && !field.allowedValues?.length
}

/**
 * The project an issue actually lives in, read from Jira rather than split off its key:
 * a moved issue keeps answering to its old key, and a numeric issue id would be taken
 * for a project id and load another project's lists. '' when the read fails, which
 * leaves the field on the text box its submission sends names from.
 */
export async function readIssueProjectKey(
  entry: JiraClientForSite,
  issueKey: string
): Promise<string> {
  try {
    const response = await jiraRequest<JiraRecord>(
      entry,
      `${apiBasePath(entry.site)}/issue/${encodeURIComponent(issueKey)}?fields=project`
    )
    const values = asRecord(asRecord(response).fields)
    return asString(asRecord(values.project).key)
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.site.id)
      throw error
    }
    recordSwallowedFailure('jira', error, 'issue project read failed')
    return ''
  }
}

async function readProjectList(
  entry: JiraClientForSite,
  projectKey: string,
  kind: JiraObjectListFieldKind
): Promise<JiraCreateFieldAllowedValue[]> {
  const response = await jiraRequest<unknown>(
    entry,
    `${apiBasePath(entry.site)}/project/${encodeURIComponent(projectKey)}/${
      PROJECT_LIST_PATHS[kind]
    }`
  )
  if (!Array.isArray(response)) {
    return []
  }
  // Why the id: it is what the submission carries, so a list entry without one
  // cannot name a value Jira would accept and is not offered. Why archived versions are
  // dropped: Jira's own picker hides them and refuses to set one, and an issue that
  // already holds one still shows it as an orphan row in the control.
  return response
    .filter((record) => kind !== 'versions' || asRecord(record).archived !== true)
    .map((record) => mapCreateFieldAllowedValue(record))
    .filter((option) => Boolean(option.id && option.name))
}

/**
 * Reads the project lists only for the kinds `fields` actually holds, so a screen with
 * no components/versions field costs no extra request. Best effort: a read that fails
 * leaves that kind out, the field keeps its text box, and the submission sends names —
 * which is all Orca did before. An auth failure is rethrown so a dead token cannot read
 * as "this project has no components".
 */
export async function readProjectFieldOptions(
  entry: JiraClientForSite,
  projectKey: string,
  fields: readonly JiraCreateField[]
): Promise<JiraProjectFieldOptions> {
  const kinds = new Set<JiraObjectListFieldKind>()
  for (const field of fields) {
    const kind = resolveJiraObjectListFieldKind(field)
    // Why skip a field Jira already lists: a site that supplies allowedValues scopes
    // them to the screen the field came from, which is more specific than the project.
    if (kind && needsProjectFieldOptions(field)) {
      kinds.add(kind)
    }
  }
  const options: JiraProjectFieldOptions = {}
  for (const kind of kinds) {
    try {
      const list = await readProjectList(entry, projectKey, kind)
      if (list.length > 0) {
        options[kind] = list
      }
    } catch (error) {
      if (isAuthError(error)) {
        clearToken(entry.site.id)
        throw error
      }
      recordSwallowedFailure('jira', error, `project ${kind} read failed`)
    }
  }
  return options
}

/** The field carrying the project's list, when its schema is one that needs it. */
export function withJiraProjectFieldOptions(
  field: JiraCreateField,
  options: JiraProjectFieldOptions
): JiraCreateField {
  const kind = resolveJiraObjectListFieldKind(field)
  const list = kind ? options[kind] : undefined
  // Jira's own allowedValues win: they are the ones scoped to this screen.
  return list?.length && !field.allowedValues?.length ? { ...field, allowedValues: list } : field
}
