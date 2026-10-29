import { parseIssueLinkInput, type ParsedIssueLinkInput } from '../../shared/issue-link-input'
import { getJiraSummaryLookupErrorCode } from '../../shared/jira/jira-summary-lookup'
import { getJiraSiteIdentityKey, parseJiraIssueUrl } from '../../shared/jira/jira-issue-url'
import { selectJiraLinkSite, type JiraLinkSiteFailure } from '../../shared/jira-link-site-selection'
import { buildJiraWorkspaceSource } from '../../shared/new-workspace/workspace-source'
import {
  ACCOUNT_BACKED_TASK_SOURCE_PROJECT_ID,
  normalizeTaskSourceContext
} from '../../shared/task-source-context'
import { workspaceAttachmentReferenceLabel } from '../../shared/workspace-attachments'
import type { JiraConnectionStatus, JiraIssue, JiraSite } from '../../shared/jira/jira-types'
import type { TaskProvider } from '../../shared/task-providers'
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

/** `--replace-linked-item` waives the guard that stops a Jira link replacing
 *  another provider's item. */
const REPLACE_LINKED_ITEM_FLAG = 'replace-linked-item'

const PROVIDER_LABELS: Record<TaskProvider, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  linear: 'Linear',
  jira: 'Jira'
}

/** The provider whose item `worktree.set` would overwrite, if the workspace carries one.
 *  `linkedWorkItem` and its routing context are the pair a Jira link writes, so those
 *  are the fields the guard has to read — a legacy `--pr`-only link stays untouched. */
function existingLinkProvider(worktree: RuntimeWorktreeRecord): TaskProvider | null {
  return worktree.linkedWorkItem?.provider ?? worktree.linkedTaskSourceContext?.provider ?? null
}

function describeLink(worktree: RuntimeWorktreeRecord, provider: TaskProvider): string {
  const item = worktree.linkedWorkItem
  return item
    ? `${PROVIDER_LABELS[provider]} ${workspaceAttachmentReferenceLabel(item)}`
    : PROVIDER_LABELS[provider]
}

/** `--jira-issue <key|url|null>` for a named workspace: undefined when the flag is
 *  absent, and the stored pair otherwise.
 *
 *  Every branch reads the workspace first, because `linkedWorkItem` is shared by all
 *  four task providers: an unguarded write replaces a GitHub, GitLab or Linear source
 *  and its routing context, and an unguarded `null` deletes them. */
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
    if (args.flags.get(REPLACE_LINKED_ITEM_FLAG) === true) {
      throw new RuntimeClientError(
        'invalid_argument',
        `--${REPLACE_LINKED_ITEM_FLAG} only applies with --jira-issue.`
      )
    }
    return undefined
  }
  // Why before the round trip: a mistyped key must fail on its own, not on whether a
  // runtime happens to answer.
  if (value !== null && !parseJiraIssueReference(value)) {
    throw invalidJiraIssueReference()
  }
  const shown = await args.client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', {
    worktree: args.worktree
  })
  const worktree = shown.result.worktree
  const provider = existingLinkProvider(worktree)

  if (value === null) {
    if (provider !== null && provider !== 'jira') {
      // Why warn and skip rather than fail: the clear is already what the caller meant
      // to do to *this* workspace's Jira link, and there is none. Deleting another
      // provider's item instead is the destructive answer this guard exists to stop.
      console.error(
        `warning: --jira-issue null cleared nothing: this workspace's link is ${describeLink(worktree, provider)}, not a Jira issue.`
      )
      return undefined
    }
    return { linkedWorkItem: null, linkedTaskSourceContext: null }
  }

  if (
    provider !== null &&
    provider !== 'jira' &&
    args.flags.get(REPLACE_LINKED_ITEM_FLAG) !== true
  ) {
    throw new RuntimeClientError(
      'invalid_argument',
      `This workspace is linked to ${describeLink(worktree, provider)}. Pass --${REPLACE_LINKED_ITEM_FLAG} to replace that link with a Jira issue, or clear it first.`
    )
  }

  return resolveJiraIssueLinkUpdates({
    value,
    client: args.client,
    hostId: worktree.hostId ?? null
  })
}

/** A mistyped-argument refusal, shared so the round-trip-free check in
 *  `getJiraIssueLinkFlagUpdates` and the stored-pair builder cannot disagree. */
function invalidJiraIssueReference(): RuntimeClientError {
  return new RuntimeClientError(
    'invalid_argument',
    'Pass a Jira issue key like ABC-123, a Jira issue URL, or null to clear.'
  )
}

function parseJiraIssueReference(
  value: string
): Extract<ParsedIssueLinkInput, { provider: 'jira' }> | null {
  const parsed = parseIssueLinkInput(value.trim(), 'jira')
  return parsed?.provider === 'jira' ? parsed : null
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

  const parsed = parseJiraIssueReference(value)
  if (!parsed) {
    throw invalidJiraIssueReference()
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
  } catch (error) {
    // Why only not-found: a timeout, a dead credential or a sleeping host is not a bad key, and
    // reporting it as one tells an agent to stop retrying when a retry is exactly what would work.
    // Anything else keeps its own code and detail, named with what the CLI was trying to do.
    if (getJiraSummaryLookupErrorCode(error) !== 'not-found') {
      throw new RuntimeClientError(
        error instanceof RuntimeClientError ? error.code : 'jira_issue_lookup_failed',
        `Couldn't read ${parsed.key} from ${site.displayName || site.siteUrl}, so the link was not changed: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof RuntimeClientError ? error.data : undefined
      )
    }
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
