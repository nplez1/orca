import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type {
  JiraCreateIssueArgs,
  JiraCreateIssueResult,
  JiraUser
} from '../../../shared/jira/jira-types'
import {
  JIRA_USER_FIELDS_RUNTIME_CAPABILITY,
  JIRA_USER_FIELDS_UPDATE_REQUIRED_MESSAGE
} from '../../../shared/jira/jira-detail-capabilities'
import {
  assertRuntimeEnvironmentCapability,
  callRuntimeRpc,
  runtimeEnvironmentSupportsCapability
} from './runtime-rpc-client'
import { isRuntimeProviderSearchQueryWithinLimit } from './runtime-provider-search-bounds'
import { getJiraRuntimeTarget, type RuntimeJiraSettings } from './runtime-jira-target'
import { foldTextFieldsForTarget } from './runtime-jira-text-fields'

export async function jiraCreateIssue(
  settings: RuntimeJiraSettings,
  args: JiraCreateIssueArgs
): Promise<JiraCreateIssueResult> {
  const target = getJiraRuntimeTarget(settings)
  if (target.kind === 'environment' && (args.userFieldKeys?.length ?? 0) > 0) {
    await assertRuntimeEnvironmentCapability(
      target.environmentId,
      JIRA_USER_FIELDS_RUNTIME_CAPABILITY,
      JIRA_USER_FIELDS_UPDATE_REQUIRED_MESSAGE,
      30_000
    )
  }
  const folded = await foldTextFieldsForTarget(target, args.customFields, args.textFieldKeys)
  const adjustedArgs: JiraCreateIssueArgs = args.customFields
    ? { ...args, customFields: folded.values, textFieldKeys: folded.textFieldKeys }
    : args
  return target.kind === 'environment'
    ? callRuntimeRpc<JiraCreateIssueResult>(target, 'jira.createIssue', adjustedArgs, {
        timeoutMs: 30_000
      })
    : window.api.jira.createIssue(adjustedArgs)
}

export async function jiraListAssignableUsers(
  settings: RuntimeJiraSettings,
  key: string,
  query?: string,
  siteId?: string | null,
  strict = false
): Promise<JiraUser[]> {
  return jiraListAssignableUsersForTarget(
    getJiraRuntimeTarget(settings),
    key,
    query,
    siteId,
    strict
  )
}

export async function jiraListAssignableUsersForTarget(
  target: RuntimeClientTarget,
  key: string,
  query?: string,
  siteId?: string | null,
  strict = false
): Promise<JiraUser[]> {
  if (!isRuntimeProviderSearchQueryWithinLimit(query)) {
    return []
  }
  const args = { key, query, siteId: siteId ?? undefined, ...(strict ? { strict: true } : {}) }
  return target.kind === 'environment'
    ? callRuntimeRpc<JiraUser[]>(target, 'jira.listAssignableUsers', args, { timeoutMs: 30_000 })
    : window.api.jira.listAssignableUsers(args)
}

// Remote hosts lack project search; use their capability-gated site search.
export async function jiraListAssignableUsersForProject(
  settings: RuntimeJiraSettings,
  projectIdOrKey: string,
  query?: string,
  siteId?: string | null
): Promise<JiraUser[]> {
  if (!isRuntimeProviderSearchQueryWithinLimit(query)) {
    return []
  }
  const target = getJiraRuntimeTarget(settings)
  if (target.kind === 'environment') {
    return jiraSearchUsers(settings, query, siteId)
  }
  return window.api.jira.listAssignableUsersForProject({
    projectIdOrKey,
    query,
    siteId: siteId ?? undefined
  })
}

export async function jiraSearchUsers(
  settings: RuntimeJiraSettings,
  query?: string,
  siteId?: string | null
): Promise<JiraUser[]> {
  if (!isRuntimeProviderSearchQueryWithinLimit(query)) {
    return []
  }
  const target = getJiraRuntimeTarget(settings)
  if (
    target.kind === 'environment' &&
    !(await runtimeEnvironmentSupportsCapability(
      target.environmentId,
      JIRA_USER_FIELDS_RUNTIME_CAPABILITY,
      30_000
    ))
  ) {
    return []
  }
  const args = { query, siteId: siteId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<JiraUser[]>(target, 'jira.searchUsers', args, { timeoutMs: 30_000 })
    : window.api.jira.searchUsers(args)
}
