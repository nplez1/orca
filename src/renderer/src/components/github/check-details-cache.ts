import type { PRCheckDetail, PRCheckRunDetails } from '../../../../shared/github/check-types'
import type { CacheEntry } from '@/store/github/cache-model'
import { isFresh, evictStaleEntries } from '@/store/github/cache-policy'
import { PR_CHECKS_CACHE_TTL_MS } from '@/store/github/cache-identity'

/** The build behind a check, independent of the key a surface files it under. */
export function checkDetailsBuildIdentity(check: PRCheckDetail): string {
  if (check.checkRunId) {
    return `check-run:${check.checkRunId}`
  }
  if (check.workflowRunId) {
    return `workflow-run:${check.workflowRunId}`
  }
  if (check.gitlabJobId) {
    return `gitlab-job:${check.gitlabJobId}`
  }
  if (check.url) {
    return `url:${check.url}`
  }
  return `name:${check.name}`
}

/** The row state a payload was read under; a row that has moved since is what re-arms a read. */
export type CheckDetailsRowState = {
  status: PRCheckDetail['status']
  conclusion: PRCheckDetail['conclusion']
}

export type CheckDetailsCacheEntry = CacheEntry<PRCheckRunDetails> & {
  readFor: CheckDetailsRowState
}

/** The payload a surface already holds, plus the read that produced it. */
export type CheckDetailsReadState = {
  loading?: boolean
  details: PRCheckRunDetails | null
  readAt?: number
  readFor?: CheckDetailsRowState
}

// Why: expanding and collapsing a row remounts nothing, but switching panels remounts the surface
// that owned the map — and a Jenkins build costs three main-process GETs. A payload either surface
// read is therefore available to the other, keyed by build rather than by its own row key.
const MAX_CACHED_CHECKS = 50
let cachedDetails: Record<string, CheckDetailsCacheEntry> = {}

export function readCachedCheckDetails(check: PRCheckDetail): CheckDetailsCacheEntry | undefined {
  return cachedDetails[checkDetailsBuildIdentity(check)]
}

export function rememberCheckDetails(check: PRCheckDetail, entry: CheckDetailsCacheEntry): void {
  cachedDetails = evictStaleEntries(
    { ...cachedDetails, [checkDetailsBuildIdentity(check)]: entry },
    MAX_CACHED_CHECKS
  )
}

/** Test seam: the cache outlives a mount, so a suite must not inherit another case's payloads. */
export function clearCheckDetailsCache(): void {
  cachedDetails = {}
}

export function checkDetailsRowState(check: PRCheckDetail): CheckDetailsRowState {
  return { status: check.status, conclusion: check.conclusion }
}

export function rowStateMatches(
  readFor: CheckDetailsRowState | undefined,
  check: PRCheckDetail
): boolean {
  return readFor?.status === check.status && readFor.conclusion === check.conclusion
}

/** A finished build's payload is final, so re-reading it can only cost a request. */
export function isFinalCheckDetails(details: PRCheckRunDetails): boolean {
  return (
    details.status === 'completed' &&
    details.conclusion !== null &&
    details.conclusion !== 'pending' &&
    details.conclusion !== 'action_required'
  )
}

/**
 * Whether a surface should read this check's details again.
 *
 * A payload is re-read only when something can have changed: the row moved since the read, or a run
 * that is still going outlived the checks-list TTL. An empty or failed read is re-armed by a row
 * move alone — polling a broken read is what the previous delete-on-status-change did to a good
 * one.
 */
export function checkDetailsNeedRefresh(
  state: CheckDetailsReadState | undefined,
  check: PRCheckDetail
): boolean {
  if (!state) {
    return true
  }
  if (state.loading) {
    return false
  }
  if (!state.details) {
    return !rowStateMatches(state.readFor, check)
  }
  if (!rowStateMatches(state.readFor, check)) {
    return true
  }
  if (isFinalCheckDetails(state.details)) {
    return false
  }
  return !isFresh({ data: state.details, fetchedAt: state.readAt ?? 0 }, PR_CHECKS_CACHE_TTL_MS)
}
