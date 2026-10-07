import { parseIssueLinkInput } from '../../shared/issue-link-input'
import { getJiraSiteIdentityKey, parseJiraIssueUrl } from '../../shared/jira-issue-url'
import { selectJiraLinkSite, type JiraLinkSiteFailure } from '../../shared/jira-link-site-selection'
import { buildJiraWorkspaceSource } from '../../shared/new-workspace/workspace-source'
import {
  ACCOUNT_BACKED_TASK_SOURCE_PROJECT_ID,
  normalizeTaskSourceContext
} from '../../shared/task-source-context'
import type { JiraConnectionStatus, JiraIssue, JiraSite } from '../../shared/jira-types'
import type { TaskSourceContext } from '../../shared/task-source-context'
import type { WorkspaceLinkedItem } from '../../shared/worktree/types'
import type { RuntimeWorktreeRecord } from '../../shared/runtime-types'
import { RuntimeClientError } from '../runtime-client'

/** The narrow slice of the runtime client this needs, so a test can stand in for it
 *  without pretending to be the whole transport. */
export type JiraLinkRpcClient = {
  call: <TResult>(method: string, params?: unknown) => Promise<{ result: TResult }>
}
import { getOptionalWorktreeLinkFlagValue } from './worktree-link-flag-value'

export type JiraIssueLinkUpdates =
  | { linkedWorkItem: WorkspaceLinkedItem; linkedTaskSourceContext: TaskSourceContext }
  | { linkedWorkItem: null; linkedTaskSourceContext: null }

/** `--jira-issue <key|url|null>` for a named workspace: undefined when the flag is
 *  absent, and the stored pair otherwise. Reads the workspace first because the
 *  link's source context has to name the host that owns it — only the workspace
 *  record knows that, and without it the link's later reads would route to
 *  whichever runtime the local app has active. */
export async function getJiraIssueLinkFlagUpdates(args: {
  flags: Map<string, string | boolean>
  client: JiraLinkRpcClient
  worktree: string
}): Promise<JiraIssueLinkUpdates | undefined> {
  const value = getOptionalWorktreeLinkFlagValue(args.flags, 'jira-issue', {
    allowNull: true,
    createHint: 'a Jira issue key or URL'
  })
  if (value === undefined) {
    return undefined
  }
  // Why: clearing needs no host and no lookup, so it makes no request.
  if (value === null) {
    return { linkedWorkItem: null, linkedTaskSourceContext: null }
  }
  const shown = await args.client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', {
    worktree: args.worktree
  })
  return resolveJiraIssueLinkUpdates({
    value,
    client: args.client,
    hostId: shown.result.worktree.hostId ?? null
  })
}

function siteFailure(reason: JiraLinkSiteFailure): RuntimeClientError {
  switch (reason) {
    case 'no-sites':
      return new RuntimeClientError(
        'jira_not_connected',
        'Connect Jira in Orca Settings, then link the issue.'
      )
    case 'site-not-connected':
      return new RuntimeClientError(
        'jira_site_not_connected',
        'That Jira URL belongs to a site that is not connected to this host.'
      )
    case 'ambiguous-site':
      return new RuntimeClientError(
        'jira_site_ambiguous',
        'More than one connected Jira account uses that site, so Orca cannot tell which one to read. Pass the issue URL of the account you want.'
      )
    case 'linked-site-disconnected':
      return new RuntimeClientError(
        'jira_site_not_connected',
        'The Jira site this workspace is linked to is not connected to this host.'
      )
    case 'site-unresolved':
      return new RuntimeClientError(
        'jira_site_required',
        'Pass the full Jira issue URL so Orca knows which site holds it.'
      )
  }
}

/** The issue the lookup returned must be the one that was asked for, or the stored
 *  item and its routing context disagree and the host drops the context on the next
 *  load. Same rule the link's own reader applies. */
function assertReturnedIssue(issue: JiraIssue | null, key: string, site: JiraSite): JiraIssue {
  const canonicalUrl = issue ? parseJiraIssueUrl(issue.url) : null
  if (
    !issue ||
    issue.key.toUpperCase() !== key.toUpperCase() ||
    issue.siteId !== site.id ||
    !canonicalUrl ||
    canonicalUrl.issueKey !== key.toUpperCase() ||
    getJiraSiteIdentityKey(issue.url) !== getJiraSiteIdentityKey(site.siteUrl)
  ) {
    throw new RuntimeClientError(
      'jira_issue_not_found',
      `Couldn't find ${key} on ${site.displayName || site.siteUrl}. Check the key and this host's Jira access.`
    )
  }
  return issue
}

/** Turns `--jira-issue` into the pair a workspace link is stored as.
 *
 *  A Jira link is a `linkedWorkItem` plus the `linkedTaskSourceContext` that routes
 *  its reads, and neither can be built from the key alone: the item needs the
 *  issue's title and canonical URL, the context needs the site. So this reads the
 *  issue through the host that owns the workspace, using the same site rules the
 *  workspace details dialog uses. */
export async function resolveJiraIssueLinkUpdates(args: {
  value: string | null
  client: JiraLinkRpcClient
  /** The workspace's host, so its Jira reads keep routing there instead of falling
   *  back to whichever runtime the local app has active. */
  hostId: string | null
}): Promise<JiraIssueLinkUpdates> {
  const { value, client, hostId } = args
  if (value === null) {
    return { linkedWorkItem: null, linkedTaskSourceContext: null }
  }

  const parsed = parseIssueLinkInput(value.trim(), 'jira')
  if (!parsed || parsed.provider !== 'jira') {
    throw new RuntimeClientError(
      'invalid_argument',
      'Pass a Jira issue key like ABC-123, a Jira issue URL, or null to clear.'
    )
  }

  const status = (await client.call<JiraConnectionStatus>('jira.status')).result
  const sites = status.sites ?? []
  const selection = selectJiraLinkSite({
    siteUrl: parsed.siteUrl,
    sites,
    selectedSiteId: status.selectedSiteId
  })
  if (!selection.ok) {
    throw siteFailure(selection.reason)
  }
  const site = selection.site

  let looked: JiraIssue | null
  try {
    looked = (
      await client.call<JiraIssue | null>('jira.lookupIssueSummary', {
        key: parsed.key,
        siteId: site.id
      })
    ).result
  } catch {
    // Why: the read fails for an unknown key, a dead credential and a sleeping
    // host alike, and the CLI cannot tell them apart from here.
    looked = null
  }
  const issue = assertReturnedIssue(looked, parsed.key, site)

  const linkedTaskSourceContext = normalizeTaskSourceContext({
    provider: 'jira',
    projectId: ACCOUNT_BACKED_TASK_SOURCE_PROJECT_ID,
    hostId: hostId ?? undefined,
    providerIdentity: {
      provider: 'jira',
      siteId: site.id,
      siteUrl: site.siteUrl,
      projectKey: issue.project.key
    },
    accountLabel: site.displayName || site.siteUrl
  })
  if (!linkedTaskSourceContext) {
    throw new RuntimeClientError('invalid_argument', 'Could not prepare this Jira link.')
  }

  return { linkedWorkItem: buildJiraWorkspaceSource(issue), linkedTaskSourceContext }
}
