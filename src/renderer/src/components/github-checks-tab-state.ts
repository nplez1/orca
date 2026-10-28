import type { PRCheckDetail, PRCheckRunDetails } from '../../../shared/github/check-types'
import type {
  CheckDetailsCacheEntry,
  CheckDetailsRowState
} from '@/components/github/check-details-cache'

export type CheckDetailsLoadState = {
  requestId?: number
  loading: boolean
  /** Held while a refresh runs: the surface keeps rendering it instead of a spinner. */
  details: PRCheckRunDetails | null
  error: string | null
  /** Clock and row state of the read behind `details` — staleness inputs, never rendered. */
  readAt?: number
  readFor?: CheckDetailsRowState
}

declare const checksContextOwnerBrand: unique symbol

/** Identity minted per checks context; only its reference is ever compared. */
export type GitHubChecksContextOwner = object & { readonly [checksContextOwnerBrand]?: never }

export type GitHubChecksTabState = {
  contextKey: string
  contextOwner: GitHubChecksContextOwner
  sourceChecks: GitHubChecksSource
  localChecks: PRCheckDetail[] | null
  expandedCheckKey: string | null
  detailsByCheckKey: Record<string, CheckDetailsLoadState>
}

type GitHubChecksSource = readonly PRCheckDetail[] | null | undefined

export function createGitHubChecksTabState(
  sourceChecks: GitHubChecksSource,
  contextKey: string
): GitHubChecksTabState {
  return {
    contextKey,
    contextOwner: {},
    sourceChecks,
    localChecks: null,
    expandedCheckKey: null,
    detailsByCheckKey: {}
  }
}

export function resolveGitHubChecksTabState(
  state: GitHubChecksTabState,
  sourceChecks: GitHubChecksSource,
  contextKey: string
): GitHubChecksTabState {
  if (state.contextKey !== contextKey) {
    return createGitHubChecksTabState(sourceChecks, contextKey)
  }
  return state.sourceChecks === sourceChecks
    ? state
    : resetGitHubChecksTabForSource(state, sourceChecks)
}

export function resetGitHubChecksTabForSource(
  state: GitHubChecksTabState,
  sourceChecks: GitHubChecksSource = state.sourceChecks
): GitHubChecksTabState {
  return {
    contextKey: state.contextKey,
    contextOwner: state.contextOwner,
    sourceChecks,
    localChecks: null,
    expandedCheckKey: null,
    // Why: a list refresh replaces every row object, and clearing here re-read each open detail on
    // the next render — the spinner came back on its own after every poll. Keys are the build's
    // identity, so a payload (or a read in flight) outlives the refresh; a context change, which a
    // push causes by moving the head SHA, is what drops them.
    detailsByCheckKey: state.detailsByCheckKey
  }
}

export function updateGitHubChecksTabLocalChecks(
  state: GitHubChecksTabState,
  localChecks: PRCheckDetail[]
): GitHubChecksTabState {
  return {
    ...state,
    localChecks
  }
}

export function toggleGitHubChecksTabExpandedKey(
  state: GitHubChecksTabState,
  key: string
): GitHubChecksTabState {
  return {
    ...state,
    expandedCheckKey: state.expandedCheckKey === key ? null : key
  }
}

/**
 * Unfenced write: an entry stored without a `requestId` silently drops the
 * settlement of any request already in flight for that key. Use
 * `beginGitHubChecksTabDetails` whenever a settlement is expected.
 */
export function updateGitHubChecksTabDetails(
  state: GitHubChecksTabState,
  key: string,
  details: CheckDetailsLoadState
): GitHubChecksTabState {
  return {
    ...state,
    detailsByCheckKey: {
      ...state.detailsByCheckKey,
      [key]: details
    }
  }
}

export function beginGitHubChecksTabDetails(
  state: GitHubChecksTabState,
  key: string,
  requestId: number,
  cached?: CheckDetailsCacheEntry
): GitHubChecksTabState {
  const current = state.detailsByCheckKey[key]
  // Why: a refresh must not blank rows it already has — the spinner belongs to the first read.
  const carried: Pick<CheckDetailsLoadState, 'details' | 'readAt' | 'readFor'> = current?.details
    ? { details: current.details, readAt: current.readAt, readFor: current.readFor }
    : cached?.data
      ? { details: cached.data, readAt: cached.fetchedAt, readFor: cached.readFor }
      : { details: null }
  return updateGitHubChecksTabDetails(state, key, {
    requestId,
    loading: true,
    ...carried,
    error: current?.error ?? null
  })
}

/**
 * A context change is fenced indirectly: `resolveGitHubChecksTabState` swaps in
 * a state with an empty `detailsByCheckKey`, so requests from the old context
 * find no owning entry here and settle into nothing.
 */
export function settleGitHubChecksTabDetails(
  state: GitHubChecksTabState,
  key: string,
  requestId: number,
  details: Omit<CheckDetailsLoadState, 'requestId'>
): GitHubChecksTabState {
  if (state.detailsByCheckKey[key]?.requestId !== requestId) {
    return state
  }
  return updateGitHubChecksTabDetails(state, key, { ...details, requestId })
}
