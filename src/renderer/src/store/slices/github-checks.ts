import type { AppState } from '../types'
import type { PRCheckDetail } from '../../../../shared/github/check-types'
import type { GitHubOwnerRepo, PRInfo } from '../../../../shared/github/pull-request-types'
import { getHostedReviewCacheKey } from './hosted-review-cache-identity'
import {
  getGitHubPRCacheKey,
  type RuntimeFocusSettings
} from '../../../../shared/github/github-cache-key'
import { githubRepoIdentityKey } from '../../../../shared/github/repository-identity-key'
import { derivePRCheckStatus } from '../../../../shared/pr-check-status'

export function normalizeBranchName(branch: string): string {
  return branch.replace(/^refs\/heads\//, '')
}

export const deriveCheckStatusFromChecks = derivePRCheckStatus

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

  const nextStatus = deriveCheckStatusFromChecks(checks)
  const prCache =
    prEntry.data.checksStatus === nextStatus
      ? null
      : {
          ...state.prCache,
          [prCacheKey]: {
            ...prEntry,
            data: {
              ...prEntry.data,
              checksStatus: nextStatus
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
    (args.headSha && review.headSha && review.headSha !== args.headSha)
  ) {
    return null
  }
  return {
    ...args.state.hostedReviewCache,
    [cacheKey]: { ...entry, data: { ...review, status: args.status } }
  }
}

function normalizedPRRepo(repo?: GitHubOwnerRepo | null): string | null {
  return repo ? githubRepoIdentityKey(repo) : null
}

function samePRRepo(left?: GitHubOwnerRepo | null, right?: GitHubOwnerRepo | null): boolean {
  return normalizedPRRepo(left) === normalizedPRRepo(right)
}
