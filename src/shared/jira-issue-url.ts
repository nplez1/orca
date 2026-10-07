import type { JiraIssue, JiraSite } from './jira-types'

export type ParsedJiraIssueUrl = {
  issueKey: string
  origin: string
  sitePath: string
}

export const JIRA_ISSUE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*-\d+$/

export function parseJiraIssueUrl(value: string): ParsedJiraIssueUrl | null {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    return null
  }
  const match = url.pathname.match(/^(.*)\/browse\/([^/]+)$/)
  if (!match || !JIRA_ISSUE_KEY_PATTERN.test(match[2])) {
    return null
  }
  return {
    issueKey: match[2].toUpperCase(),
    origin: url.origin.toLowerCase(),
    sitePath: normalizeSitePath(match[1])
  }
}

export function getMatchingJiraSites(
  parsed: ParsedJiraIssueUrl,
  sites: readonly JiraSite[]
): JiraSite[] {
  return sites.filter((site) => {
    const identity = getJiraSiteIdentity(site.siteUrl)
    return (
      identity !== null &&
      identity.origin === parsed.origin &&
      identity.sitePath === parsed.sitePath
    )
  })
}

export function isResolvedJiraIssueMatch(
  parsed: ParsedJiraIssueUrl,
  site: JiraSite,
  issue: JiraIssue
): boolean {
  const canonical = parseJiraIssueUrl(issue.url)
  return (
    issue.key.toUpperCase() === parsed.issueKey &&
    issue.siteId === site.id &&
    canonical !== null &&
    canonical.issueKey === parsed.issueKey &&
    getMatchingJiraSites(canonical, [site]).length === 1
  )
}

function getJiraSiteIdentity(
  value: string
): Pick<ParsedJiraIssueUrl, 'origin' | 'sitePath'> | null {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    return null
  }
  return {
    origin: url.origin.toLowerCase(),
    sitePath: normalizeSitePath(url.pathname)
  }
}

/** A comparable identity for a Jira site URL or an issue URL: `origin` + site
 *  path, with the trailing slash normalized away, so `https://acme.atlassian.net`,
 *  `https://acme.atlassian.net/browse/ABC-1` and `https://acme.atlassian.net/jira`
 *  all reduce to the site they name. Null when the value is not an http(s) URL a
 *  Jira site could be, so callers cannot accidentally match on garbage.
 *
 *  Exported because a stored workspace link keeps its site URL and the dialog
 *  compares a typed site against it; both must use one definition. */
export function getJiraSiteIdentityKey(value: string | null | undefined): string | null {
  if (!value) {
    return null
  }
  const issueUrl = parseJiraIssueUrl(value)
  if (issueUrl) {
    return `${issueUrl.origin}${issueUrl.sitePath}`
  }
  const identity = getJiraSiteIdentity(value)
  return identity ? `${identity.origin}${identity.sitePath}` : null
}

function normalizeSitePath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/g, '')
  return trimmed === '/' ? '' : trimmed
}
