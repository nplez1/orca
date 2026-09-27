import type { WorkspacePathSearchCorrelationId } from './workspace-path-search-instrumentation'
import { measureUtf8ByteLength } from './utf8-byte-limits'
import { MAX_MESSAGE_SIZE } from './relay-frame-decoder'
import { REMOTE_RPC_MAX_CONTENT_BYTES } from './remote-rpc-content-budget'
import { REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES } from './remote-runtime-memory-limits'
import {
  QUICK_OPEN_QUERY_MAX_BYTES,
  QUICK_OPEN_REMOTE_QUERY_MAX_CODE_UNITS,
  splitPathQueryTokens
} from './quick-open-path-search'

export const WORKSPACE_PATH_SEARCH_LOCAL_QUERY_MAX_UTF8_BYTES = QUICK_OPEN_QUERY_MAX_BYTES
export const WORKSPACE_PATH_SEARCH_REMOTE_QUERY_MAX_CODE_UNITS =
  QUICK_OPEN_REMOTE_QUERY_MAX_CODE_UNITS
/** Legacy runtime schema limit; negotiate before sending the larger Explorer page. */
export const WORKSPACE_PATH_SEARCH_LEGACY_RUNTIME_MAX_PAGE_PATHS = 32
export const WORKSPACE_PATH_SEARCH_LOCAL_EXPLORER_MAX_PAGE_PATHS = 5_000

/** Static ceilings only; callers still apply each request's and peer's smaller byte budget. */
export const WORKSPACE_PATH_SEARCH_TRANSPORT_BYTE_CEILINGS = {
  remoteRuntimeJson: REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES,
  remoteRpcContent: REMOTE_RPC_MAX_CONTENT_BYTES,
  relayFramePayload: MAX_MESSAGE_SIZE
} as const

export const WORKSPACE_PATH_SEARCH_LIMITS = {
  localQueryMaxUtf8Bytes: WORKSPACE_PATH_SEARCH_LOCAL_QUERY_MAX_UTF8_BYTES,
  remoteQueryMaxCodeUnits: WORKSPACE_PATH_SEARCH_REMOTE_QUERY_MAX_CODE_UNITS,
  legacyRuntimeMaxPagePaths: WORKSPACE_PATH_SEARCH_LEGACY_RUNTIME_MAX_PAGE_PATHS,
  localExplorerMaxPagePaths: WORKSPACE_PATH_SEARCH_LOCAL_EXPLORER_MAX_PAGE_PATHS,
  transportByteCeilings: WORKSPACE_PATH_SEARCH_TRANSPORT_BYTE_CEILINGS
} as const

export type WorkspacePathSearchProviderIdentity = {
  /** Provider kind/ID is intentionally open for folder, SSH, WSL, and future hosts. */
  provider: string
  incarnationId: string
}

export type WorkspacePathSearchOwnerIdentity = {
  executionHost: WorkspacePathSearchProviderIdentity
  /** Canonical root authorized by the execution host for this request. */
  authorizedCanonicalRoot: string
}

/** `name-filter` is substring-AND; `quick-open` remains fuzzy-ranked. */
export type WorkspacePathSearchMode = 'name-filter' | 'quick-open'
export type WorkspacePathSearchPathSet = 'included' | 'all'

export type WorkspacePathSearchScopeDescriptor = {
  pathSet: WorkspacePathSearchPathSet
  includeDotfiles: boolean
  includeIgnoredFiles: boolean
  /** Each entry is a normalized relative path split into path segments. */
  excludePathSegments: readonly (readonly string[])[]
}

export type WorkspacePathSearchPageBudget = {
  maxPaths: number
  maxSerializedBytes: number
}

export type WorkspacePathSearchConsumerSequence = {
  consumerId: string
  sequence: number
}

/** Includes every input that can change which page is correct, including generation and scope. */
export type WorkspacePathSearchFenceIdentity = {
  query: string
  consumer: WorkspacePathSearchConsumerSequence
  owner: WorkspacePathSearchOwnerIdentity
  /** Null asks the host to resolve its latest publishable generation. */
  generationId: string | null
  mode: WorkspacePathSearchMode
  scope: WorkspacePathSearchScopeDescriptor
  pageBudget: WorkspacePathSearchPageBudget
}

export type WorkspacePathSearchRequest = {
  identity: WorkspacePathSearchFenceIdentity
  correlationId: WorkspacePathSearchCorrelationId
}

/** Unknown wire values map conservatively to `unavailable` instead of invalidating the reply. */
export type WorkspacePathSearchCoverage = 'complete' | 'partial' | 'unavailable'

export const WORKSPACE_PATH_SEARCH_FRESHNESS_STATES = [
  'no-known-gap',
  'dirty',
  'reconciling',
  'provisional',
  'disconnected',
  'failed',
  'unknown'
] as const

/** Readers must treat unrecognized future freshness values conservatively, not reject the reply. */
export type WorkspacePathSearchFreshness =
  | (typeof WORKSPACE_PATH_SEARCH_FRESHNESS_STATES)[number]
  | (string & {})

export const WORKSPACE_PATH_SEARCH_COUNT_PROVENANCES = [
  'exact-snapshot',
  'provisional',
  'last-known',
  'sentinel',
  'legacy'
] as const

/** Unknown wire values map to non-authoritative `legacy` rather than rejecting the reply. */
export type WorkspacePathSearchCountProvenance =
  (typeof WORKSPACE_PATH_SEARCH_COUNT_PROVENANCES)[number]

export type WorkspacePathSearchCount =
  | { value: number; provenance: 'exact-snapshot' }
  | {
      value: number | null
      provenance: Exclude<WorkspacePathSearchCountProvenance, 'exact-snapshot'>
    }

/**
 * Only the complete/no-known-gap/exact-snapshot arm authorizes a definitive empty-state claim.
 * New state strings must stay on a non-authoritative arm until their semantics are understood.
 */
export type WorkspacePathSearchResultState =
  | {
      coverage: 'complete'
      freshness: 'no-known-gap'
      countProvenance: 'exact-snapshot'
      searchComplete: true
    }
  | {
      coverage: 'complete'
      freshness: WorkspacePathSearchFreshness
      countProvenance: Exclude<WorkspacePathSearchCountProvenance, 'exact-snapshot'>
      searchComplete: true
    }
  | {
      coverage: Exclude<WorkspacePathSearchCoverage, 'complete'>
      freshness: WorkspacePathSearchFreshness
      countProvenance: Exclude<WorkspacePathSearchCountProvenance, 'exact-snapshot'>
      searchComplete: false
    }

export type WorkspacePathSearchRow = {
  relativePath: string
}

export const WORKSPACE_PATH_SEARCH_ROW_FLAGS = {
  ignored: 1,
  dotfile: 2,
  ignoreClassificationKnown: 4
} as const

/** Bit flags aligned by index with `rows`; ignored is meaningful only when classification is known. */
export type WorkspacePathSearchRowClassificationFlags = 0 | 2 | 4 | 5 | 6 | 7

export const WORKSPACE_PATH_SEARCH_DEGRADATION_REASONS = [
  'missing',
  'building',
  'expired',
  'over-budget',
  'failed',
  'uncovered-scope',
  'classification-pending',
  'interrupted',
  'disconnected',
  'transport-budget',
  'unsupported',
  'feature-disabled',
  'cancelled',
  'authorization-revoked',
  /** A restored provisional generation answered from a bounded natural-order prefix. */
  'partial-page-bounded'
] as const

/** Future reason strings remain readable by older clients as opaque degradation reasons. */
export type WorkspacePathSearchDegradationReason =
  | (typeof WORKSPACE_PATH_SEARCH_DEGRADATION_REASONS)[number]
  | (string & {})

/**
 * Legacy adapter seam: project this response to the unchanged FilePathSearchResult only for legacy
 * callers; new structured fields are capability-gated so old readers retain established semantics.
 */
type WorkspacePathSearchResponseBase = {
  requestIdentity: WorkspacePathSearchFenceIdentity
  generationId: string
  scopeFingerprint: string
  scopeRuleVersion: string
  /** Bounded by both requestIdentity.pageBudget limits; count may exceed this retained page. */
  rows: readonly WorkspacePathSearchRow[]
  /** Same length and ordering as rows; avoids a second array of repeated path strings. */
  rowClassificationFlags: readonly WorkspacePathSearchRowClassificationFlags[]
  /** Equals rows.length; the total count is reported separately and is never page-clamped. */
  retainedCount: number
  degradationReason?: WorkspacePathSearchDegradationReason
}

export type WorkspacePathSearchResponse =
  | (WorkspacePathSearchResponseBase & {
      state: Extract<WorkspacePathSearchResultState, { countProvenance: 'exact-snapshot' }>
      count: Extract<WorkspacePathSearchCount, { provenance: 'exact-snapshot' }>
    })
  | (WorkspacePathSearchResponseBase & {
      state: Exclude<WorkspacePathSearchResultState, { countProvenance: 'exact-snapshot' }>
      count: Exclude<WorkspacePathSearchCount, { provenance: 'exact-snapshot' }>
    })

export const WORKSPACE_PATH_SEARCH_NAME_FILTER_CAPABILITY = 'filePathSearch.nameFilter.v1'

export const WORKSPACE_PATH_SEARCH_NAME_FILTER_NEGOTIATION_KEYS = {
  capability: WORKSPACE_PATH_SEARCH_NAME_FILTER_CAPABILITY,
  matcherVersion: 'matcherVersion',
  supportedScopes: 'supportedScopes',
  maxPagePaths: 'maxPagePaths',
  maxPageSerializedBytes: 'maxPageSerializedBytes',
  freshnessMetadata: 'freshnessMetadata'
} as const

export type WorkspacePathSearchCapabilityDescriptor = {
  matcherVersion: number
  supportedScopes: readonly WorkspacePathSearchPathSet[]
  supportsDotfileVisibility: boolean
  supportsIgnoredFileVisibility: boolean
  supportsExcludePathSegments: boolean
  maxPagePaths: number
  maxPageSerializedBytes: number
  freshnessMetadata: boolean
}

export * from './workspace-path-search-instrumentation'

export type WorkspacePathSearchQueryValidationError =
  | 'not-a-string'
  | 'remote-code-unit-limit'
  | 'utf8-byte-limit'

export type WorkspacePathSearchQueryValidationResult =
  | {
      ok: true
      query: string
      tokens: string[]
      utf8ByteLength: number
    }
  | {
      ok: false
      reason: WorkspacePathSearchQueryValidationError
      maxUtf8Bytes: number
      maxRemoteCodeUnits: number
    }

/** Validation and tokenization are pure; token folding stays owned by the shared matcher. */
export function validateWorkspacePathSearchQuery(
  query: unknown,
  surface: 'local' | 'remote' = 'local'
): WorkspacePathSearchQueryValidationResult {
  if (typeof query !== 'string') {
    return {
      ok: false,
      reason: 'not-a-string',
      maxUtf8Bytes: WORKSPACE_PATH_SEARCH_LOCAL_QUERY_MAX_UTF8_BYTES,
      maxRemoteCodeUnits: WORKSPACE_PATH_SEARCH_REMOTE_QUERY_MAX_CODE_UNITS
    }
  }
  if (surface === 'remote' && query.length > WORKSPACE_PATH_SEARCH_REMOTE_QUERY_MAX_CODE_UNITS) {
    return {
      ok: false,
      reason: 'remote-code-unit-limit',
      maxUtf8Bytes: WORKSPACE_PATH_SEARCH_LOCAL_QUERY_MAX_UTF8_BYTES,
      maxRemoteCodeUnits: WORKSPACE_PATH_SEARCH_REMOTE_QUERY_MAX_CODE_UNITS
    }
  }
  if (query.length > WORKSPACE_PATH_SEARCH_LOCAL_QUERY_MAX_UTF8_BYTES) {
    return {
      ok: false,
      reason: 'utf8-byte-limit',
      maxUtf8Bytes: WORKSPACE_PATH_SEARCH_LOCAL_QUERY_MAX_UTF8_BYTES,
      maxRemoteCodeUnits: WORKSPACE_PATH_SEARCH_REMOTE_QUERY_MAX_CODE_UNITS
    }
  }

  const measurement = measureUtf8ByteLength(query, {
    stopAfterBytes: WORKSPACE_PATH_SEARCH_LOCAL_QUERY_MAX_UTF8_BYTES
  })
  if (measurement.exceededLimit) {
    return {
      ok: false,
      reason: 'utf8-byte-limit',
      maxUtf8Bytes: WORKSPACE_PATH_SEARCH_LOCAL_QUERY_MAX_UTF8_BYTES,
      maxRemoteCodeUnits: WORKSPACE_PATH_SEARCH_REMOTE_QUERY_MAX_CODE_UNITS
    }
  }

  return {
    ok: true,
    query,
    tokens: splitPathQueryTokens(query),
    utf8ByteLength: measurement.byteLength
  }
}
