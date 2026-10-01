import { githubRepoIdentityKey } from '../../../../shared/github/repository-identity-key'
import { ghExecFileAsync } from '../../gh-utils'
import { githubHostExecOptions, type GitHubApiRepository } from '../../github-api-repository'
import { noteRepositoryRateLimitSpend, repositoryRateLimitGuard } from '../../rate-limit'
import type { GhExecOptions } from '../github-exec-scope'
import type { PullRequestLookupData } from './pull-request-lookup-data'

/**
 * `reviewDecision` is a fact about the pull request; whether the viewer may merge anyway is a
 * different question, and only GitHub knows the answer — a ruleset's bypass list, or an
 * administrator waiving classic branch protection. So the merged verdict is not computed here:
 * the flag is fetched, and the presenters that hard-block on `reviewDecision` consult it.
 */
export const VIEWER_CAN_MERGE_AS_ADMIN_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      viewerCanMergeAsAdmin
    }
  }
}`

// Why: the answer changes only when branch rules or the signed-in account do, and the worktree list
// re-looks-up every PR on a timer — a minute of reuse keeps the shared GraphQL budget off this probe.
// The key is per execution scope, not per account, so switching gh accounts inside one scope can
// serve the previous account's answer until it expires. That is why the merge preflight re-reads the
// flag and GitHub, not this cache, decides whether the merge is allowed.
export const VIEWER_MERGE_PRIVILEGE_CACHE_TTL_MS = 60_000

export const VIEWER_MERGE_PRIVILEGE_CACHE_MAX_ENTRIES = 512

type ViewerMergePrivilegeEntry = { value: boolean | undefined; expiresAt: number }

export const viewerMergePrivilegeCache = new Map<string, ViewerMergePrivilegeEntry>()

const viewerMergePrivilegeInFlight = new Map<string, Promise<boolean | undefined>>()

export function pruneViewerMergePrivilegeCache(now = Date.now()): void {
  for (const [key, cached] of viewerMergePrivilegeCache) {
    if (cached.expiresAt <= now) {
      viewerMergePrivilegeCache.delete(key)
    }
  }
  while (viewerMergePrivilegeCache.size > VIEWER_MERGE_PRIVILEGE_CACHE_MAX_ENTRIES) {
    const oldestKey = viewerMergePrivilegeCache.keys().next().value
    if (oldestKey === undefined) {
      return
    }
    viewerMergePrivilegeCache.delete(oldestKey)
  }
}

/**
 * Whether the review gate is the thing standing between this viewer and a merge, which is the only
 * case worth spending a GraphQL request on. A draft, closed, or merged pull request cannot be
 * merged at all, and an approved one has nothing to waive.
 */
export function hasUnmetReviewGate(data: {
  state?: string | null
  isDraft?: boolean
  reviewDecision?: string | null
}): boolean {
  const state = (data.state ?? '').toUpperCase()
  if (state === 'CLOSED' || state === 'MERGED' || state === 'DRAFT' || data.isDraft === true) {
    return false
  }
  return data.reviewDecision === 'REVIEW_REQUIRED' || data.reviewDecision === 'CHANGES_REQUESTED'
}

/**
 * GitHub's `PullRequest.viewerCanMergeAsAdmin`: "whether the viewer can bypass branch protections
 * and merge the pull request immediately". `undefined` means GitHub did not answer — a rate-limit
 * guard, a network failure, or a host without the field — and every caller must treat that as
 * "unknown", never as "cannot": the app must not invent a permission the viewer may have.
 */
export async function getViewerCanMergeAsAdmin(
  ownerRepo: GitHubApiRepository,
  number: number,
  ghOptions: GhExecOptions,
  executionScope = 'default'
): Promise<boolean | undefined> {
  const cacheKey = `${executionScope}\0${githubRepoIdentityKey(ownerRepo)}#${number}`
  const now = Date.now()
  pruneViewerMergePrivilegeCache(now)
  const cached = viewerMergePrivilegeCache.get(cacheKey)
  if (cached && cached.expiresAt > now) {
    return cached.value
  }
  const existing = viewerMergePrivilegeInFlight.get(cacheKey)
  if (existing) {
    return existing
  }
  const request = fetchViewerCanMergeAsAdmin(ownerRepo, number, ghOptions).then((value) => {
    viewerMergePrivilegeCache.set(cacheKey, {
      value,
      expiresAt: Date.now() + VIEWER_MERGE_PRIVILEGE_CACHE_TTL_MS
    })
    return value
  })
  viewerMergePrivilegeInFlight.set(cacheKey, request)
  try {
    return await request
  } finally {
    viewerMergePrivilegeInFlight.delete(cacheKey)
  }
}

async function fetchViewerCanMergeAsAdmin(
  ownerRepo: GitHubApiRepository,
  number: number,
  ghOptions: GhExecOptions
): Promise<boolean | undefined> {
  const guard = repositoryRateLimitGuard(ownerRepo, 'graphql', ghOptions)
  if (guard.blocked) {
    return undefined
  }
  try {
    noteRepositoryRateLimitSpend(ownerRepo, 'graphql', 1, ghOptions)
    const { stdout } = await ghExecFileAsync(
      [
        'api',
        'graphql',
        '-f',
        `query=${VIEWER_CAN_MERGE_AS_ADMIN_QUERY}`,
        '-f',
        `owner=${ownerRepo.owner}`,
        '-f',
        `repo=${ownerRepo.repo}`,
        '-F',
        `number=${String(number)}`
      ],
      { ...ghOptions, ...githubHostExecOptions(ownerRepo) }
    )
    // Why: annotate rather than cast — `JSON.parse` is `any`, and the annotation is the contract
    // this query is matched against.
    const parsed: {
      data?: { repository?: { pullRequest?: { viewerCanMergeAsAdmin?: unknown } | null } | null }
    } = JSON.parse(stdout)
    const value = parsed.data?.repository?.pullRequest?.viewerCanMergeAsAdmin
    return typeof value === 'boolean' ? value : undefined
  } catch {
    // Why: an unanswerable probe must degrade to today's behaviour (the review gate blocks),
    // not to a bypass offer GitHub has not authorised.
    return undefined
  }
}

/** Adds the probe to a lookup only when an unmet review gate makes the answer actionable. */
export async function attachViewerCanMergeAsAdmin(
  ownerRepo: GitHubApiRepository,
  data: PullRequestLookupData,
  ghOptions: GhExecOptions,
  executionScope: string
): Promise<PullRequestLookupData> {
  if (!hasUnmetReviewGate(data)) {
    return data
  }
  const viewerCanMergeAsAdmin = await getViewerCanMergeAsAdmin(
    ownerRepo,
    data.number,
    ghOptions,
    executionScope
  )
  return viewerCanMergeAsAdmin === undefined ? data : { ...data, viewerCanMergeAsAdmin }
}
