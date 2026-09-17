import { resolveSessionSearchLimit } from '../../shared/ai-vault-search-limit'
import type {
  AiVaultSearchHostStatus,
  AiVaultSearchRequest,
  AiVaultSearchResponse
} from '../../shared/ai-vault-search-types'
import { sessionSearchPageKey } from '../ai-vault-search/session-search-page-cursor'
import {
  MergedSearchOrderCache,
  createFrozenMergedSearchOrder,
  decodeMergedSearchCursor,
  encodeMergedSearchCursor,
  type DecodedMergedSearchCursor,
  type FrozenMergedSearchOrder
} from './ai-vault-search-merged-order'
import {
  compareHostStatuses,
  discoverHostSearchLegs,
  isContributedLeg,
  perHostSearchRequest,
  probeRecordedHost,
  runHostLegs,
  runSearchLeg,
  toHostStatus,
  type AiVaultSearchAllHostDeps,
  type SearchLegResult
} from './ai-vault-search-host-fanout'
import { fuseHostRankings } from './session-search-rank-fusion'

const mergedSearchOrders = new MergedSearchOrderCache()

export function resetMergedSearchOrdersForTests(): void {
  mergedSearchOrders.clear()
}

/**
 * One merged page.
 *
 * Page one fuses every reachable host and freezes the order. Later pages slice
 * that frozen order and probe each recorded host's generation, so an in-flight
 * pagination is a snapshot the freshness flag admits to — never a live re-fuse
 * that would reorder rows mid-read.
 */
export function searchAllExecutionHosts(args: {
  request: AiVaultSearchRequest
  /** The caller's limit was already clamped to the per-host ceiling, silently. */
  requestedDepthExceededCeiling?: boolean
  deps: AiVaultSearchAllHostDeps
}): Promise<AiVaultSearchResponse> {
  const startedAt = performance.now()
  const pageKey = sessionSearchPageKey(args.request)
  if (!args.request.cursor) {
    return fuseFirstMergedPage({ ...args, pageKey, startedAt })
  }
  const cursor = decodeMergedSearchCursor(args.request.cursor)
  if (!cursor) {
    return Promise.resolve({ kind: 'malformed-cursor' })
  }
  const order = mergedSearchOrders.get(cursor.seqId)
  if (!order || order.pageKey !== cursor.pageKey || cursor.pageKey !== pageKey) {
    // A cursor belongs to one query and one frozen order; a client that changed
    // either re-issues page one rather than seeing a different ranking.
    return Promise.resolve({
      kind: 'stale-cursor',
      generation: maxRecordedGeneration(cursor.perHostGeneration)
    })
  }
  return sliceFrozenMergedPage({ order, cursor, request: args.request, deps: args.deps, startedAt })
}

async function fuseFirstMergedPage(args: {
  request: AiVaultSearchRequest
  requestedDepthExceededCeiling?: boolean
  pageKey: string
  startedAt: number
  deps: AiVaultSearchAllHostDeps
}): Promise<AiVaultSearchResponse> {
  const { legs, discoveryFailures, statuses } = discoverHostSearchLegs(args.deps)
  for (const failure of discoveryFailures) {
    console.error(`[ai-vault] ${failure} host discovery failed for an all-hosts search`)
  }
  const perHostRequest = perHostSearchRequest(args.request)
  const results = await runHostLegs(legs, (leg) => runSearchLeg(leg, perHostRequest))
  const contributed = results.filter(isContributedLeg)
  if (contributed.length === 0) {
    // Nothing to merge and nothing to freeze: an empty success would claim the
    // corpus is empty when the truth is that no index answered.
    return { kind: 'unavailable', reason: aggregateUnavailableReason(results) }
  }
  const order = createFrozenMergedSearchOrder({
    pageKey: args.pageKey,
    perHostGeneration: Object.fromEntries(
      contributed.map((leg) => [leg.executionHostId, leg.generation])
    ),
    hits: fuseHostRankings(contributed),
    depthLimited:
      args.requestedDepthExceededCeiling === true ||
      contributed.some((leg) => leg.pageFull || leg.retrievalIncomplete),
    queryTruncated: contributed.some((leg) => leg.queryTruncated),
    snippetTruncationCount: sum(contributed.map((leg) => leg.snippetTruncationCount)),
    freshnessAtFusion: contributed.some((leg) => leg.freshness),
    generation: Math.max(...contributed.map((leg) => leg.generation))
  })
  mergedSearchOrders.put(order)
  return buildMergedResultsPage({
    order,
    offset: 0,
    limit: resolveSessionSearchLimit(args.request.limit),
    generation: order.generation,
    freshness: order.freshnessAtFusion,
    statuses: [...statuses, ...results.map(toHostStatus)],
    durationMs: performance.now() - args.startedAt
  })
}

async function sliceFrozenMergedPage(args: {
  order: FrozenMergedSearchOrder
  cursor: DecodedMergedSearchCursor
  request: AiVaultSearchRequest
  startedAt: number
  deps: AiVaultSearchAllHostDeps
}): Promise<AiVaultSearchResponse> {
  // Probes, not re-searches: the hits are the frozen ones either way, so asking
  // each host to rank again would only pay for rows this page throws away.
  const recordedHosts = Object.entries(args.cursor.perHostGeneration).map(
    ([executionHostId, generation]) => ({ executionHostId, generation })
  )
  const probes = await runHostLegs(recordedHosts, (host) => probeRecordedHost(host, args.deps))
  // Any recorded host we could not re-observe makes the snapshot unverifiable, so
  // the page says so instead of implying it is current.
  const snapshotMoved = probes.some((probe) => probe.outcome !== 'contributed' || !probe.matches)
  return buildMergedResultsPage({
    order: args.order,
    offset: args.cursor.offset,
    limit: resolveSessionSearchLimit(args.request.limit),
    generation: Math.max(
      maxRecordedGeneration(args.cursor.perHostGeneration),
      ...probes.map((probe) => (probe.outcome === 'contributed' ? probe.generation : 0))
    ),
    freshness: args.order.freshnessAtFusion || snapshotMoved,
    statuses: probes.map(toHostStatus),
    durationMs: performance.now() - args.startedAt
  })
}

function buildMergedResultsPage(args: {
  order: FrozenMergedSearchOrder
  offset: number
  limit: number
  generation: number
  freshness: boolean
  statuses: readonly AiVaultSearchHostStatus[]
  durationMs: number
}): AiVaultSearchResponse {
  const hits = args.order.hits.slice(args.offset, args.offset + args.limit)
  const hasMore = args.order.hits.length > args.offset + args.limit
  return {
    kind: 'results',
    hits,
    page: {
      cursor: hasMore ? encodeMergedSearchCursor(args.order, args.offset + args.limit) : null,
      hasMore
    },
    generation: args.generation,
    truncated: {
      candidates: args.order.depthLimited,
      snippets: args.order.snippetTruncationCount,
      query: args.order.queryTruncated,
      freshness: args.freshness
    },
    durationMs: args.durationMs,
    hosts: [...args.statuses].sort(compareHostStatuses)
  }
}

/**
 * The strongest denial the answering hosts agree on. A leg that timed out or
 * failed proves nothing about its host, so it cannot contribute a reason.
 */
function aggregateUnavailableReason(
  results: readonly SearchLegResult[]
): 'disabled' | 'not-ready' | 'no-service' {
  const answered = results.flatMap((result) =>
    result.outcome === 'contributed' || result.reason === 'timeout' || result.reason === 'failed'
      ? []
      : [result.reason]
  )
  if (answered.every((reason) => reason === 'no-service')) {
    return 'no-service'
  }
  return answered.every((reason) => reason === 'disabled') ? 'disabled' : 'not-ready'
}

function maxRecordedGeneration(perHostGeneration: Readonly<Record<string, number>>): number {
  const generations = Object.values(perHostGeneration)
  return generations.length === 0 ? 0 : Math.max(...generations)
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

export type { AiVaultSearchAllHostDeps }
