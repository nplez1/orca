import type { JiraCreateField, JiraCreateFieldAllowedValue } from '../../shared/jira-types'
import {
  resolveJiraObjectListFieldKind,
  type JiraObjectListFieldKind
} from '../../shared/jira-field-rendering'
import { apiBasePath, jiraRequest, type JiraClientForSite } from './authenticated-request'
import { clearToken, isAuthError } from './client'
import { mapCreateFieldAllowedValue } from './jira-issue-mapping'

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

/** The project an issue key belongs to. Jira issue keys are `<project key>-<number>`
 *  and a project key never contains a dash, so the last dash splits the two. */
export function projectKeyOfIssueKey(issueKey: string): string {
  const separator = issueKey.lastIndexOf('-')
  return separator > 0 ? issueKey.slice(0, separator) : issueKey
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
  // cannot name a value Jira would accept and is not offered.
  return response
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
    if (kind && !field.allowedValues?.length) {
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
      console.warn(`[jira] project ${kind} read failed:`, error)
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
