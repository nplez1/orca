import { getHostedReviewCacheKey } from '../../slices/hosted-review/hosted-review-cache-identity'
import type { AppState } from '../../types'
import type { PRCheckDetail } from '../../../../../shared/github/check-types'
import type { GitHubOwnerRepo, PRInfo } from '../../../../../shared/github/pull-request-types'
import {
  getGitHubPRCacheKey,
  type RuntimeFocusSettings
} from '../../../../../shared/github/github-cache-key'
import { githubRepoIdentityKey } from '../../../../../shared/github/repository-identity-key'
import { derivePRCheckStatus } from '../../../../../shared/source-control/checks/pr-check-status'

export function normalizeBranchName(branch: string): string {
  return branch.replace(/^refs\/heads\//, '')
}

export function syncPRChecksStatus(
  state: AppState,
  repoPath: string,
  repoId: string | undefined,
  branch: string | undefined,
  checks: PRCheckDetail[],
  headSha?: string,
  prRepo?: GitHubOwnerRepo | null,
  settings?: RuntimeFocusSettings,
  connectionId?: string | null,
  executionHostId?: string | null,
  hasRepoOwner = false
): Partial<AppState> | null {
  const normalized = branch ? normalizeBranchName(branch) : ''
  if (!normalized) {
    return null
  }

  const prCacheKey = getGitHubPRCacheKey(
    repoPath,
    repoId,
    normalized,
    settings,
    connectionId,
    executionHostId,
    hasRepoOwner
  )
  const prEntry = state.prCache[prCacheKey]
  if (!prEntry?.data) {
    return null
  }
  // Fork rediscovery can retarget branch cache mid-check request; update only matching PR repo identity.
  if (prRepo !== undefined && !samePRRepo(prEntry.data.prRepo, prRepo)) {
    return null
  }
  if (headSha && prEntry.data.headSha && prEntry.data.headSha !== headSha) {
    return null
  }

  const nextStatus = derivePRCheckStatus(checks)
  // Detail pages are partial; retain the complete same-head summary until the next PR lookup.
  const prCache =
    prEntry.data.checksStatus === nextStatus
      ? null
      : {
          ...state.prCache,
          [prCacheKey]: {
            ...prEntry,
            data: {
              ...prEntry.data,
              checksStatus: nextStatus,
              checksSummary: undefined
            }
          }
        }
  // Why: the sidebar card renders a GitHub review from the hosted-review entry, so the same verdict
  // has to land there too or the card trails the panel until the next background PR refresh.
  const hostedReviewCache = syncHostedReviewStatus({
    state,
    repoPath,
    repoId,
    branch: normalized,
    settings,
    connectionId,
    executionHostId,
    hasRepoOwner,
    number: prEntry.data.number,
    prRepo: prEntry.data.prRepo,
    headSha,
    status: nextStatus
  })
  if (!prCache && !hostedReviewCache) {
    return null
  }
  return { ...(prCache ? { prCache } : {}), ...(hostedReviewCache ? { hostedReviewCache } : {}) }
}

function syncHostedReviewStatus(args: {
  state: AppState
  repoPath: string
  repoId: string | undefined
  branch: string
  settings: RuntimeFocusSettings
  connectionId: string | null | undefined
  executionHostId: string | null | undefined
  hasRepoOwner: boolean
  number: number
  prRepo: PRInfo['prRepo']
  headSha: string | undefined
  status: PRInfo['checksStatus']
}): AppState['hostedReviewCache'] | null {
  const cacheKey = getHostedReviewCacheKey(
    args.repoPath,
    args.branch,
    args.settings,
    args.repoId,
    args.connectionId,
    args.executionHostId,
    args.hasRepoOwner
  )
  const entry = args.state.hostedReviewCache?.[cacheKey]
  const review = entry?.data
  if (
    !entry ||
    !review ||
    review.provider !== 'github' ||
    review.number !== args.number ||
    review.status === args.status ||
    (args.headSha && review.headSha && review.headSha !== args.headSha) ||
    !samePRRepo(review.githubRepository, args.prRepo)
  ) {
    return null
  }
  return {
    ...args.state.hostedReviewCache,
    [cacheKey]: { ...entry, data: { ...review, status: args.status, checksSummary: undefined } }
  }
}

function normalizedPRRepo(repo?: GitHubOwnerRepo | null): string | null {
  return repo ? githubRepoIdentityKey(repo) : null
}

function samePRRepo(left?: GitHubOwnerRepo | null, right?: GitHubOwnerRepo | null): boolean {
  return normalizedPRRepo(left) === normalizedPRRepo(right)
}
