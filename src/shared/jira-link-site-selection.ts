import { getJiraSiteIdentityKey } from './jira-issue-url'
import type { JiraSite, JiraSiteSelection } from './jira-types'

/** Why a Jira link could not be pinned to a site. Callers turn these into their
 *  own copy: the dialog translates, the CLI raises a `RuntimeClientError`. */
export type JiraLinkSiteFailure =
  /** No Jira site is connected at all. */
  | 'no-sites'
  /** A URL named a site this host does not have connected. */
  | 'site-not-connected'
  /** Two accounts share the URL's site, so the key alone cannot pick one. */
  | 'ambiguous-site'
  /** A bare key, and nothing the user already chose names a site. */
  | 'site-unresolved'
  /** A bare key, and the site the workspace is linked to is gone. */
  | 'linked-site-disconnected'

export type JiraLinkSiteSelection =
  | { ok: true; site: JiraSite }
  | { ok: false; reason: JiraLinkSiteFailure }

/** Which connected Jira site holds the issue a typed value names.
 *
 *  Shared by the workspace details dialog and the CLI so the two cannot drift:
 *  both accept a bare `ABC-123` or an issue URL, and both must refuse to guess a
 *  site rather than read the right key from the wrong host. A URL is decisive; a
 *  bare key may only use a site the user already chose — the one the workspace
 *  reads from, then the one selected in Settings, then a lone connected site — and
 *  a workspace's own site that is no longer connected fails instead of falling
 *  through to another site, which would move a live link. */
export function selectJiraLinkSite(args: {
  siteUrl: string | null
  sites: readonly JiraSite[]
  selectedSiteId?: JiraSiteSelection | null
  /** The site the workspace's current link reads from, when it has one. */
  linkedSiteId?: string | null
}): JiraLinkSiteSelection {
  const { siteUrl, sites, selectedSiteId, linkedSiteId } = args
  // Why first: with nothing connected no other answer is more useful, whatever the
  // input named.
  if (sites.length === 0) {
    return { ok: false, reason: 'no-sites' }
  }
  const typedSiteKey = siteUrl ? getJiraSiteIdentityKey(siteUrl) : null

  if (typedSiteKey) {
    const matchingSites = sites.filter(
      (site) => getJiraSiteIdentityKey(site.siteUrl) === typedSiteKey
    )
    if (matchingSites.length === 0) {
      return { ok: false, reason: 'site-not-connected' }
    }
    // Why: two accounts can be connected to one Jira host, and the key alone does
    // not say which to read. Only the site the workspace already uses may break the
    // tie; picking the first would read from an account the user did not name.
    const site =
      matchingSites.length === 1
        ? matchingSites[0]
        : matchingSites.find((candidate) => candidate.id === linkedSiteId)
    return site ? { ok: true, site } : { ok: false, reason: 'ambiguous-site' }
  }

  if (linkedSiteId && !sites.some((site) => site.id === linkedSiteId)) {
    return { ok: false, reason: 'linked-site-disconnected' }
  }
  const candidates = [
    linkedSiteId,
    selectedSiteId && selectedSiteId !== 'all' ? selectedSiteId : null,
    sites.length === 1 ? sites[0].id : null
  ].filter((id): id is string => typeof id === 'string' && id.length > 0)
  const site = candidates
    .map((id) => sites.find((candidate) => candidate.id === id))
    .find((candidate) => candidate !== undefined)
  return site ? { ok: true, site } : { ok: false, reason: 'site-unresolved' }
}
