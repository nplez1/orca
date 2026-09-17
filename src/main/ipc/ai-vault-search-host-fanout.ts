import { ZodError } from 'zod'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toSshExecutionHostId
} from '../../shared/execution-host'
import { mapSettledWithConcurrency } from '../../shared/map-with-concurrency'
import type { createSessionSearchClient } from '../../shared/ai-vault-search-client'
import { SESSION_SEARCH_LIMIT_MAX } from '../../shared/ai-vault-search-limit'
import type {
  AiVaultSearchHostReason,
  AiVaultSearchHostStatus,
  AiVaultSearchHit,
  AiVaultSearchRequest,
  AiVaultSearchResponse,
  AiVaultSearchStatus
} from '../../shared/ai-vault-search-types'
import { AI_VAULT_ALL_HOST_TIMEOUT_MS } from './ai-vault-all-host-timeouts'
import type { RuntimeAiVaultHostInfo } from './ai-vault-runtime-scan'

export type SessionSearchClient = ReturnType<typeof createSessionSearchClient>

/**
 * Everything the merger needs to reach a host. Every leg is a client that already
 * applies that transport's redaction, so nothing here re-decides exposure.
 */
export type AiVaultSearchAllHostDeps = {
  /** This desktop's own index, over desktop IPC. */
  localClient: SessionSearchClient
  discoverSshHosts: () => readonly { targetId: string }[]
  sshClient: (targetId: string) => SessionSearchClient
  discoverRuntimeHosts: () => readonly RuntimeAiVaultHostInfo[]
  /** Null when this desktop has no transport for that runtime. */
  runtimeClient: (environmentId: string) => SessionSearchClient | null
}

/** Hosts get one page each; 6 at a time keeps a 20-host fan-out off the socket pool. */
export const MERGED_SEARCH_FANOUT_CONCURRENCY = 6
/** A broken enumerator names no host, so its entry carries the surface it was listing. */
const SSH_DISCOVERY_HOST_ID = 'ssh'
const RUNTIME_DISCOVERY_HOST_ID = 'runtime'

export type HostSearchLeg = {
  executionHostId: string
  client: SessionSearchClient
}

type ContributedSearchLeg = {
  outcome: 'contributed'
  executionHostId: string
  hits: AiVaultSearchHit[]
  generation: number
  /** The host had more rows than it returned, so ranks below the ceiling are missing. */
  pageFull: boolean
  retrievalIncomplete: boolean
  queryTruncated: boolean
  snippetTruncationCount: number
  freshness: boolean
}

export type FailedSearchLeg = {
  outcome: 'unavailable' | 'error'
  executionHostId: string
  reason: AiVaultSearchHostReason
}

export type SearchLegResult = ContributedSearchLeg | FailedSearchLeg

type HostProbeResult =
  | {
      outcome: 'contributed'
      executionHostId: string
      generation: number
      /** The probed generation still equals the one this order was fused from. */
      matches: boolean
    }
  | FailedSearchLeg

type HostLegOutcome = SearchLegResult | HostProbeResult

class SearchLegDeadlineError extends Error {
  constructor() {
    super('Search leg exceeded its deadline')
    this.name = 'SearchLegDeadlineError'
  }
}

export function discoverHostSearchLegs(deps: AiVaultSearchAllHostDeps): {
  legs: HostSearchLeg[]
  statuses: AiVaultSearchHostStatus[]
  discoveryFailures: string[]
} {
  const legs: HostSearchLeg[] = [
    { executionHostId: LOCAL_EXECUTION_HOST_ID, client: deps.localClient }
  ]
  const statuses: AiVaultSearchHostStatus[] = []
  const discoveryFailures: string[] = []
  const pushLeg = (executionHostId: string, client: SessionSearchClient): void => {
    // Two arms of the fan-out that resolve to one host would double-count its
    // ranks, so the first spelling of a host id wins.
    if (!legs.some((leg) => leg.executionHostId === executionHostId)) {
      legs.push({ executionHostId, client })
    }
  }

  const sshHosts = enumerateHosts(deps.discoverSshHosts)
  if (sshHosts.failed) {
    discoveryFailures.push('SSH')
    statuses.push({ executionHostId: SSH_DISCOVERY_HOST_ID, outcome: 'error', reason: 'failed' })
  }
  for (const host of sshHosts.hosts) {
    if (host.targetId) {
      pushLeg(toSshExecutionHostId(host.targetId), deps.sshClient(host.targetId))
    }
  }

  const runtimeHosts = enumerateHosts(deps.discoverRuntimeHosts)
  if (runtimeHosts.failed) {
    discoveryFailures.push('runtime')
    statuses.push({
      executionHostId: RUNTIME_DISCOVERY_HOST_ID,
      outcome: 'error',
      reason: 'failed'
    })
  }
  for (const host of runtimeHosts.hosts) {
    const client = deps.runtimeClient(host.environmentId)
    if (!client) {
      statuses.push({
        executionHostId: host.executionHostId,
        outcome: 'unavailable',
        reason: 'no-service'
      })
      continue
    }
    pushLeg(host.executionHostId, client)
  }

  return { legs, statuses, discoveryFailures }
}

/**
 * Every host is asked for the ceiling, not for the caller's page size: RRF wants
 * depth per host, and the frozen order is sliced to the page size later. The
 * merged cursor is the desktop's own and must not reach a host.
 */
export function perHostSearchRequest(request: AiVaultSearchRequest): AiVaultSearchRequest {
  return {
    query: request.query,
    limit: SESSION_SEARCH_LIMIT_MAX,
    ...(request.scope ? { scope: request.scope } : {}),
    ...(request.freshness ? { freshness: request.freshness } : {}),
    ...(request.filters ? { filters: request.filters } : {})
  }
}

/**
 * Runs one leg per host, bounded, and never rejects: an unexpected rejection
 * becomes that host's failure instead of taking the whole merged page down.
 */
export async function runHostLegs<T extends { executionHostId: string }, R extends HostLegOutcome>(
  items: readonly T[],
  run: (item: T) => Promise<R>
): Promise<(R | FailedSearchLeg)[]> {
  const settled = await mapSettledWithConcurrency(items, MERGED_SEARCH_FANOUT_CONCURRENCY, run)
  return settled.map((result, index) =>
    result.status === 'fulfilled'
      ? result.value
      : classifyThrownLeg(items[index].executionHostId, result.reason)
  )
}

export async function runSearchLeg(
  leg: HostSearchLeg,
  request: AiVaultSearchRequest
): Promise<SearchLegResult> {
  try {
    const response: AiVaultSearchResponse = await withSearchLegDeadline(
      leg.client.searchSessions(request)
    )
    if (response.kind === 'results') {
      return {
        outcome: 'contributed',
        executionHostId: leg.executionHostId,
        // The desktop owns addressing, so attribution is stamped here rather
        // than trusted from the payload.
        hits: response.hits.map((hit) => ({ ...hit, executionHostId: leg.executionHostId })),
        generation: response.generation,
        pageFull: response.page.hasMore,
        retrievalIncomplete: response.truncated.candidates,
        queryTruncated: response.truncated.query,
        snippetTruncationCount: response.truncated.snippets,
        freshness: response.truncated.freshness
      }
    }
    if (response.kind === 'unavailable') {
      return {
        outcome: 'unavailable',
        executionHostId: leg.executionHostId,
        reason: response.reason
      }
    }
    // We never send a cursor to a host, so a cursor refusal is a broken answer.
    return { outcome: 'error', executionHostId: leg.executionHostId, reason: 'malformed' }
  } catch (error) {
    return classifyThrownLeg(leg.executionHostId, error)
  }
}

export async function probeRecordedHost(
  args: { executionHostId: string; generation: number },
  deps: AiVaultSearchAllHostDeps
): Promise<HostProbeResult> {
  const client = recordedHostClient(args.executionHostId, deps)
  if (!client) {
    return { outcome: 'unavailable', executionHostId: args.executionHostId, reason: 'no-service' }
  }
  try {
    const status = await withSearchLegDeadline(client.searchStatus())
    if (!status.enabled) {
      return {
        outcome: 'unavailable',
        executionHostId: args.executionHostId,
        reason: isAbsentServiceStatus(status) ? 'no-service' : 'disabled'
      }
    }
    return {
      outcome: 'contributed',
      executionHostId: args.executionHostId,
      generation: status.generation,
      matches: status.generation === args.generation
    }
  } catch (error) {
    return classifyThrownLeg(args.executionHostId, error)
  }
}

/** Null for a host that did not answer; the aggregate simply has no row for it. */
export async function probeHostStatus(leg: HostSearchLeg): Promise<AiVaultSearchStatus | null> {
  try {
    return await withSearchLegDeadline(leg.client.searchStatus())
  } catch {
    return null
  }
}

export function toHostStatus(result: HostLegOutcome): AiVaultSearchHostStatus {
  return result.outcome === 'contributed'
    ? { executionHostId: result.executionHostId, outcome: 'contributed' }
    : { executionHostId: result.executionHostId, outcome: result.outcome, reason: result.reason }
}

export function compareHostStatuses(
  a: AiVaultSearchHostStatus,
  b: AiVaultSearchHostStatus
): number {
  return a.executionHostId < b.executionHostId ? -1 : a.executionHostId > b.executionHostId ? 1 : 0
}

export function isContributedLeg(result: SearchLegResult): result is ContributedSearchLeg {
  return result.outcome === 'contributed'
}

function recordedHostClient(
  executionHostId: string,
  deps: AiVaultSearchAllHostDeps
): SessionSearchClient | null {
  const parsed = parseExecutionHostId(executionHostId)
  if (!parsed) {
    return null
  }
  switch (parsed.kind) {
    case 'local':
      return deps.localClient
    case 'ssh':
      return deps.sshClient(parsed.targetId)
    case 'runtime':
      return deps.runtimeClient(parsed.environmentId)
  }
}

function classifyThrownLeg(executionHostId: string, error: unknown): FailedSearchLeg {
  if (error instanceof SearchLegDeadlineError) {
    return { outcome: 'unavailable', executionHostId, reason: 'timeout' }
  }
  if (error instanceof ZodError) {
    return { outcome: 'error', executionHostId, reason: 'malformed' }
  }
  // Loss of contact proves nothing about the host's index, so it is never an error.
  return { outcome: 'unavailable', executionHostId, reason: 'failed' }
}

function withSearchLegDeadline<T>(work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // The abandoned leg keeps running; only this page stops waiting on it.
    const timer = setTimeout(
      () => reject(new SearchLegDeadlineError()),
      AI_VAULT_ALL_HOST_TIMEOUT_MS.searchLeg
    )
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

function enumerateHosts<T>(enumerate: () => readonly T[]): {
  hosts: readonly T[]
  failed: boolean
} {
  try {
    return { hosts: enumerate(), failed: false }
  } catch {
    return { hosts: [], failed: true }
  }
}

function isAbsentServiceStatus(status: AiVaultSearchStatus): boolean {
  return !status.enabled && status.phase === 'idle' && status.generation === 0
}
