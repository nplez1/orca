import { useCallback } from 'react'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { buildJiraWorkspaceSource } from '../../../../shared/new-workspace/workspace-source'
import { getJiraSiteIdentityKey, parseJiraIssueUrl } from '../../../../shared/jira-issue-url'
import {
  selectJiraLinkSite,
  type JiraLinkSiteFailure
} from '../../../../shared/jira-link-site-selection'
import {
  ACCOUNT_BACKED_TASK_SOURCE_PROJECT_ID,
  normalizeTaskSourceContext
} from '../../../../shared/task-source-context'
import type { Worktree } from '../../../../shared/worktree/types'
import type { JiraSite } from '../../../../shared/jira-types'
import type { ResolvedJiraIssueLink } from './worktree-meta-updates'

/** The placeholder project the account-backed task sources already use for Jira:
 *  a Jira task source is scoped by site, not by project, so `projectId` is only a
 *  cache-scope key. Kept identical to the Task view's so both write one scope. */
const JIRA_ACCOUNT_SCOPE_PROJECT_ID = ACCOUNT_BACKED_TASK_SOURCE_PROJECT_ID

/** The dialog's copy for a site the shared selector could not resolve. */
function jiraSiteFailureMessage(reason: JiraLinkSiteFailure): string {
  switch (reason) {
    case 'site-not-connected':
      return translate(
        'auto.components.sidebar.useWorktreeMetaJiraLink.4c1f7a2b90',
        'That Jira URL belongs to a site that is not connected.'
      )
    case 'ambiguous-site':
      return translate(
        'auto.components.sidebar.useWorktreeMetaJiraLink.9b7f1d38a4',
        'More than one connected Jira account uses that site, so Orca cannot tell which one to read.'
      )
    case 'linked-site-disconnected':
      return translate(
        'auto.components.sidebar.useWorktreeMetaJiraLink.2e5a90c47b',
        'The Jira site this workspace is linked to is not connected.'
      )
    case 'no-sites':
      return translate(
        'auto.components.sidebar.useWorktreeMetaJiraLink.8d2e0b6f31',
        'Connect Jira in Settings, then link the issue.'
      )
    case 'site-unresolved':
      return translate(
        'auto.components.sidebar.useWorktreeMetaJiraLink.1a9c45e7d3',
        'Paste the full Jira issue URL so Orca knows which site holds it.'
      )
  }
}

// Why: a shared empty array. Returning a fresh `[]` from a selector makes
// `useSyncExternalStore` see a new snapshot on every render and loop.
const NO_SITES: readonly JiraSite[] = []

export type JiraWorktreeLinkResolution =
  | { ok: true; link: ResolvedJiraIssueLink }
  | { ok: false; error: string }

/** Turns typed Jira text into the stored shape of a workspace link.
 *
 *  Jira has no dedicated `linkedIssue`-style slot, so a link is a
 *  `linkedWorkItem` plus the source context that routes its reads. Neither can be
 *  built from the key alone: the item needs the issue's title and canonical URL,
 *  and the context needs the site. That is why this is a lookup, and why the
 *  dialog must treat a failed lookup as a failed save rather than writing a
 *  half-link the pane could not read. */
export function useResolveWorktreeMetaJiraLink(args: {
  /** Only the two fields this needs: the host its reads must route to, and the
   *  context a link already routed through. */
  worktree: Pick<Worktree, 'hostId' | 'linkedTaskSourceContext'> | undefined
}): (parsed: { key: string; siteUrl: string | null }) => Promise<JiraWorktreeLinkResolution> {
  const { worktree } = args
  // Why: the site inventory is global `jiraStatus`, the same source the Jira Tasks
  // view reads (`use-task-page-repo-selection.ts`). A workspace on a remote host
  // shares it, so a per-host inventory is the app's open limitation, not one this
  // dialog introduces — the host is still carried in the context it writes.
  const sites = useAppStore((s) => s.jiraStatus.sites) ?? NO_SITES
  const selectedSiteId = useAppStore((s) => s.jiraStatus.selectedSiteId ?? null)
  const lookupJiraIssueSummary = useAppStore((s) => s.lookupJiraIssueSummary)
  const liveContext = worktree?.linkedTaskSourceContext ?? null

  return useCallback(
    async (parsed) => {
      const connectedSites = sites
      const liveIdentity = liveContext?.provider === 'jira' ? liveContext.providerIdentity : null
      const liveSiteId = liveIdentity?.provider === 'jira' ? liveIdentity.siteId : null
      // Why shared: the CLI links a Jira issue with the same site rules, so the
      // choice lives in one place and only the copy differs.
      const selection = selectJiraLinkSite({
        siteUrl: parsed.siteUrl,
        sites: connectedSites,
        selectedSiteId,
        linkedSiteId: liveSiteId
      })
      if (!selection.ok) {
        return { ok: false, error: jiraSiteFailureMessage(selection.reason) }
      }
      const site = selection.site

      // Why: the stored item and its context must agree on the site, the project
      // key and the issue key or the host drops the context on the next load
      // (`isWorkspaceLinkedItemSourceContextMatch`). Deriving the project key from
      // the issue key is the same rule that predicate applies.
      const projectKey = parsed.key.slice(0, parsed.key.lastIndexOf('-'))
      const sourceContext = normalizeTaskSourceContext({
        provider: 'jira',
        projectId: liveContext?.projectId ?? JIRA_ACCOUNT_SCOPE_PROJECT_ID,
        // Why the workspace's own host: it is what routes a remote workspace's read
        // to the host that holds its Jira credential, instead of the active runtime.
        hostId: liveContext?.hostId ?? worktree?.hostId,
        providerIdentity: {
          provider: 'jira',
          siteId: site.id,
          siteUrl: site.siteUrl,
          projectKey
        },
        accountLabel: site.displayName || site.siteUrl
      })
      if (!sourceContext) {
        return {
          ok: false,
          error: translate(
            'auto.components.sidebar.useWorktreeMetaJiraLink.6f3b8c0a52',
            'Could not prepare this Jira link.'
          )
        }
      }

      try {
        const issue = await lookupJiraIssueSummary(sourceContext, parsed.key, site.id)
        // Why: the identity is checked rather than assumed. A moved or reused key can
        // come back as another issue, and context plus item would then disagree — the
        // host keeps the item and drops its routing context, leaving a link the pane
        // cannot read. This is `isResolvedJiraIssueMatch`'s rule applied to what the
        // lookup actually returned, key and site included.
        const returnedUrl = issue ? parseJiraIssueUrl(issue.url) : null
        if (
          !issue ||
          issue.key.toUpperCase() !== parsed.key.toUpperCase() ||
          issue.siteId !== site.id ||
          !returnedUrl ||
          returnedUrl.issueKey !== parsed.key.toUpperCase() ||
          getJiraSiteIdentityKey(issue.url) !== getJiraSiteIdentityKey(site.siteUrl)
        ) {
          return {
            ok: false,
            error: translate(
              'auto.components.sidebar.useWorktreeMetaJiraLink.b5d9e17c48',
              "Couldn't find {{key}} on {{site}}. Check the key and your Jira access.",
              { key: parsed.key, site: site.displayName || site.siteUrl }
            )
          }
        }
        return {
          ok: true,
          link: {
            linkedWorkItem: buildJiraWorkspaceSource(issue),
            linkedTaskSourceContext: sourceContext
          }
        }
      } catch {
        return {
          ok: false,
          error: translate(
            'auto.components.sidebar.useWorktreeMetaJiraLink.27e6a3d1f5',
            "Couldn't read {{key}} from Jira. Check your Jira connection and try again.",
            { key: parsed.key }
          )
        }
      }
    },
    [liveContext, lookupJiraIssueSummary, selectedSiteId, sites, worktree?.hostId]
  )
}
