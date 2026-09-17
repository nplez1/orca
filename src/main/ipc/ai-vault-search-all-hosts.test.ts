import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ZodError } from 'zod'
import { unavailableSessionSearchStatus } from '../../shared/ai-vault-search-client'
import { toRuntimeExecutionHostId } from '../../shared/execution-host'
import { aiVaultSearchHit, aiVaultSearchResults } from '../../shared/ai-vault-search-test-fixture'
import type {
  AiVaultSearchHit,
  AiVaultSearchResponse,
  AiVaultSearchStatus
} from '../../shared/ai-vault-search-types'
import {
  resetMergedSearchOrdersForTests,
  searchAllExecutionHosts,
  type AiVaultSearchAllHostDeps
} from './ai-vault-search-all-hosts'
import { searchAllExecutionHostsStatus } from './ai-vault-search-status-aggregation'
import type { SessionSearchClient } from './ai-vault-search-host-fanout'

type FakeHostOptions = {
  hits?: AiVaultSearchHit[]
  generation?: number
  hasMore?: boolean
  candidates?: boolean
  searchFailure?: 'unreachable' | 'malformed' | 'unavailable' | 'never'
  statusFailure?: boolean
  statusEnabled?: boolean
  filesIndexed?: number
}

type FakeHost = {
  client: SessionSearchClient
  /** Search calls only: a later page probes status instead of re-searching. */
  searches: () => number
  probes: () => number
  setGeneration: (generation: number) => void
  setStatusFailure: (failed: boolean) => void
}

function fakeHost(initial: FakeHostOptions = {}): FakeHost {
  const state = { generation: 7, ...initial }
  let searches = 0
  let probes = 0
  return {
    client: {
      searchSessions: async (): Promise<AiVaultSearchResponse> => {
        searches += 1
        const failure = state.searchFailure
        if (failure === 'unreachable') {
          throw new Error('SSH relay is not ready')
        }
        if (failure === 'malformed') {
          throw new ZodError([])
        }
        if (failure === 'unavailable') {
          return { kind: 'unavailable', reason: 'disabled' }
        }
        if (failure === 'never') {
          return new Promise<never>(() => {})
        }
        return aiVaultSearchResults({
          hits: state.hits ?? [],
          generation: state.generation,
          hasMore: state.hasMore ?? false,
          truncated: state.candidates ? { candidates: true } : {}
        })
      },
      searchStatus: async (): Promise<AiVaultSearchStatus> => {
        probes += 1
        if (state.statusFailure) {
          throw new Error('SSH relay is not ready')
        }
        return {
          ...unavailableSessionSearchStatus(),
          enabled: state.statusEnabled ?? true,
          filesIndexed: state.filesIndexed ?? 0,
          generation: state.generation
        }
      }
    },
    searches: () => searches,
    probes: () => probes,
    setGeneration: (generation) => {
      state.generation = generation
    },
    setStatusFailure: (failed) => {
      state.statusFailure = failed
    }
  }
}

function hostDeps(args: {
  local: FakeHost
  ssh?: Record<string, FakeHost>
  runtime?: Record<string, FakeHost | null>
  sshDiscoveryFails?: boolean
  runtimeDiscoveryFails?: boolean
}): AiVaultSearchAllHostDeps {
  const ssh = args.ssh ?? {}
  const runtime = args.runtime ?? {}
  return {
    localClient: args.local.client,
    discoverSshHosts: () => {
      if (args.sshDiscoveryFails) {
        throw new Error('ssh store unavailable')
      }
      return Object.keys(ssh).map((targetId) => ({ targetId }))
    },
    sshClient: (targetId) => ssh[targetId]!.client,
    discoverRuntimeHosts: () => {
      if (args.runtimeDiscoveryFails) {
        throw new Error('runtime store unavailable')
      }
      return Object.entries(runtime).map(([environmentId]) => ({
        environmentId,
        executionHostId: toRuntimeExecutionHostId(environmentId)
      }))
    },
    runtimeClient: (environmentId) => runtime[environmentId]?.client ?? null
  }
}

function resultsOf(
  response: AiVaultSearchResponse
): Extract<AiVaultSearchResponse, { kind: 'results' }> {
  if (response.kind !== 'results') {
    throw new Error(`expected results, got ${response.kind}`)
  }
  return response
}

function sessionIds(response: AiVaultSearchResponse): string[] {
  return response.kind === 'results' ? response.hits.map((hit) => hit.sessionId) : []
}

function hostStatuses(response: AiVaultSearchResponse): Record<string, string> {
  const hosts = response.kind === 'results' ? (response.hosts ?? []) : []
  return Object.fromEntries(hosts.map((host) => [host.executionHostId, host.outcome]))
}

beforeEach(() => {
  resetMergedSearchOrdersForTests()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('all-hosts merged search', () => {
  it('fuses every reachable host and reports each one', async () => {
    const local = fakeHost({
      hits: [aiVaultSearchHit({ sessionId: 'local-1', updatedAt: '2024-01-01T00:00:00.000Z' })],
      generation: 3
    })
    const alpha = fakeHost({
      hits: [aiVaultSearchHit({ sessionId: 'alpha-1', updatedAt: '2024-03-01T00:00:00.000Z' })],
      generation: 5
    })
    const beta = fakeHost({
      hits: [aiVaultSearchHit({ sessionId: 'beta-1', updatedAt: '2024-02-01T00:00:00.000Z' })],
      generation: 9
    })

    const response = await searchAllExecutionHosts({
      request: { query: 'needle' },
      deps: hostDeps({ local, ssh: { alpha, beta } })
    })

    // Three rank-one rows tie on score, so the order is decided by updatedAt.
    expect(sessionIds(response)).toEqual(['alpha-1', 'beta-1', 'local-1'])
    expect(response.kind === 'results' && response.generation).toBe(9)
    expect(hostStatuses(response)).toEqual({
      local: 'contributed',
      'ssh:alpha': 'contributed',
      'ssh:beta': 'contributed'
    })
    expect(local.searches()).toBe(1)
  })

  it('asks every host for the per-host ceiling, not for the page size', async () => {
    const local = fakeHost()
    const requests: unknown[] = []
    const spy = fakeHost()
    spy.client.searchSessions = async (request) => {
      requests.push(request)
      return aiVaultSearchResults({ hits: [], generation: 7 })
    }

    await searchAllExecutionHosts({
      request: { query: 'needle', limit: 5 },
      deps: hostDeps({ local, ssh: { alpha: spy } })
    })

    expect(requests).toEqual([{ query: 'needle', limit: 100 }])
  })

  it('keeps the other hosts rows when one host errors or times out', async () => {
    const local = fakeHost({
      hits: [aiVaultSearchHit({ sessionId: 'local-1' })],
      generation: 2
    })
    const broken = fakeHost({ searchFailure: 'unreachable' })
    const malformed = fakeHost({ searchFailure: 'malformed' })
    const slow = fakeHost({ searchFailure: 'never' })

    vi.useFakeTimers()
    const pending = searchAllExecutionHosts({
      request: { query: 'needle' },
      deps: hostDeps({ local, ssh: { broken, malformed, slow } })
    })
    await vi.advanceTimersByTimeAsync(8_001)
    const response = await pending

    expect(sessionIds(response)).toEqual(['local-1'])
    const hosts = resultsOf(response).hosts ?? []
    expect(hosts).toEqual([
      { executionHostId: 'local', outcome: 'contributed' },
      { executionHostId: 'ssh:broken', outcome: 'unavailable', reason: 'failed' },
      { executionHostId: 'ssh:malformed', outcome: 'error', reason: 'malformed' },
      { executionHostId: 'ssh:slow', outcome: 'unavailable', reason: 'timeout' }
    ])
  })

  it('reports a full host page as truncated candidates', async () => {
    const local = fakeHost()
    const full = fakeHost({
      hits: [aiVaultSearchHit({ sessionId: 'rank-1', cwd: '/work/a' })],
      hasMore: true
    })

    const response = await searchAllExecutionHosts({
      request: { query: 'needle' },
      deps: hostDeps({ local, ssh: { full } })
    })

    expect(resultsOf(response).truncated.candidates).toBe(true)
  })

  it('reports a depth the caller asked for past the ceiling as truncated candidates', async () => {
    const local = fakeHost()

    const response = await searchAllExecutionHosts({
      request: { query: 'needle' },
      requestedDepthExceededCeiling: true,
      deps: hostDeps({ local })
    })

    expect(resultsOf(response).truncated.candidates).toBe(true)
  })

  it('dedupes a transcript seen on two hosts and prefers the present source', async () => {
    const local = fakeHost({
      hits: [
        aiVaultSearchHit({
          sessionId: 'shared-transcript',
          cwd: '/work/repo',
          source: { presence: 'missing' }
        })
      ]
    })
    const alpha = fakeHost({
      hits: [
        aiVaultSearchHit({
          sessionId: 'shared-transcript',
          cwd: '/work/repo',
          source: { presence: 'present', filePath: '/work/repo/session.jsonl' }
        })
      ]
    })

    const response = await searchAllExecutionHosts({
      request: { query: 'needle' },
      deps: hostDeps({ local, ssh: { alpha } })
    })

    const hits = resultsOf(response).hits
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({
      executionHostId: 'ssh:alpha',
      source: { presence: 'present' }
    })
    expect(hits[0]?.score).toBeCloseTo(2 / 61)
  })

  it('lists a discovered host with no transport as unavailable', async () => {
    const local = fakeHost({ hits: [aiVaultSearchHit({ sessionId: 'local-1' })] })

    const response = await searchAllExecutionHosts({
      request: { query: 'needle' },
      deps: hostDeps({ local, runtime: { 'env-without-transport': null } })
    })

    expect(hostStatuses(response)).toEqual({
      local: 'contributed',
      'runtime:env-without-transport': 'unavailable'
    })
  })

  it('reports a broken host enumerator instead of silently omitting its hosts', async () => {
    const local = fakeHost({ hits: [aiVaultSearchHit({ sessionId: 'local-1' })] })

    const response = await searchAllExecutionHosts({
      request: { query: 'needle' },
      deps: hostDeps({ local, sshDiscoveryFails: true })
    })

    expect(sessionIds(response)).toEqual(['local-1'])
    expect(resultsOf(response).hosts).toContainEqual({
      executionHostId: 'ssh',
      outcome: 'error',
      reason: 'failed'
    })
  })

  it('reports a disabled index when every answering host is disabled', async () => {
    const local = fakeHost({ searchFailure: 'unavailable' })

    const response = await searchAllExecutionHosts({
      request: { query: 'needle' },
      deps: hostDeps({ local, runtime: { 'env-without-transport': null } })
    })

    expect(response).toEqual({ kind: 'unavailable', reason: 'disabled' })
  })

  it('answers unavailable/no-service when nothing answers at all', async () => {
    const local = fakeHost({ searchFailure: 'unreachable' })

    const response = await searchAllExecutionHosts({
      request: { query: 'needle' },
      deps: hostDeps({ local })
    })

    expect(response).toEqual({ kind: 'unavailable', reason: 'no-service' })
  })

  it('refuses a cursor that is not opaque to us', async () => {
    const local = fakeHost()

    const response = await searchAllExecutionHosts({
      request: { query: 'needle', cursor: 'not-a-cursor' },
      deps: hostDeps({ local })
    })

    expect(response).toEqual({ kind: 'malformed-cursor' })
    expect(local.searches()).toBe(0)
  })
})

describe('frozen merged pagination', () => {
  async function firstPage(): Promise<{
    response: AiVaultSearchResponse
    local: FakeHost
    alpha: FakeHost
    deps: AiVaultSearchAllHostDeps
  }> {
    const local = fakeHost({
      hits: [
        aiVaultSearchHit({
          sessionId: 'local-1',
          cwd: '/work/local',
          updatedAt: '2024-01-01T00:00:00.000Z'
        })
      ],
      generation: 7
    })
    const alpha = fakeHost({
      hits: [
        aiVaultSearchHit({
          sessionId: 'alpha-1',
          cwd: '/work/alpha',
          updatedAt: '2024-04-01T00:00:00.000Z'
        }),
        aiVaultSearchHit({
          sessionId: 'alpha-2',
          cwd: '/work/alpha-2',
          updatedAt: '2024-03-01T00:00:00.000Z'
        })
      ],
      generation: 7
    })
    const deps = hostDeps({ local, ssh: { alpha } })
    const response = await searchAllExecutionHosts({
      request: { query: 'needle', limit: 1 },
      deps
    })
    expect(sessionIds(response)).toEqual(['alpha-1'])
    return { response, local, alpha, deps }
  }

  it('slices the frozen order instead of re-fusing or re-searching', async () => {
    const { response, local, alpha, deps } = await firstPage()
    const cursor = resultsOf(response).page.cursor
    expect(cursor).not.toBeNull()
    expect(resultsOf(response).page.hasMore).toBe(true)

    // Frozen order is [alpha-1 (1/61), local-1 (1/61), alpha-2 (1/62)].
    const second = await searchAllExecutionHosts({
      request: { query: 'needle', limit: 1, cursor: cursor! },
      deps
    })

    expect(sessionIds(second)).toEqual(['local-1'])
    expect(resultsOf(second).page.hasMore).toBe(true)
    // Page two probes status; it never asks a host to rank again.
    expect(local.searches()).toBe(1)
    expect(alpha.searches()).toBe(1)
    expect(alpha.probes()).toBe(1)

    const third = await searchAllExecutionHosts({
      request: { query: 'needle', limit: 1, cursor: resultsOf(second).page.cursor! },
      deps
    })
    expect(sessionIds(third)).toEqual(['alpha-2'])
    expect(resultsOf(third).page.hasMore).toBe(false)
    expect(resultsOf(third).page.cursor).toBeNull()
  })

  it('admits a moved generation without reordering the frozen page', async () => {
    const { response, alpha, deps } = await firstPage()
    const cursor = resultsOf(response).page.cursor!

    alpha.setGeneration(99)
    const second = await searchAllExecutionHosts({
      request: { query: 'needle', limit: 1, cursor },
      deps
    })

    expect(sessionIds(second)).toEqual(['local-1'])
    expect(resultsOf(second).truncated.freshness).toBe(true)
    expect(resultsOf(second).generation).toBe(99)
  })

  it('marks a host lost mid-cursor as unavailable and still renders the snapshot', async () => {
    const { response, alpha, deps } = await firstPage()
    const cursor = resultsOf(response).page.cursor!

    alpha.setStatusFailure(true)
    const second = await searchAllExecutionHosts({
      request: { query: 'needle', limit: 2, cursor },
      deps
    })

    expect(sessionIds(second)).toEqual(['local-1', 'alpha-2'])
    expect(hostStatuses(second)).toMatchObject({ 'ssh:alpha': 'unavailable' })
    expect(resultsOf(second).truncated.freshness).toBe(true)
  })

  it('refuses a cursor for a different query or an evicted order', async () => {
    const { response, deps } = await firstPage()
    const cursor = resultsOf(response).page.cursor!

    const otherQuery = await searchAllExecutionHosts({
      request: { query: 'different', limit: 1, cursor },
      deps
    })
    expect(otherQuery.kind).toBe('stale-cursor')
    expect(otherQuery.kind === 'stale-cursor' && otherQuery.generation).toBe(7)

    resetMergedSearchOrdersForTests()
    const evicted = await searchAllExecutionHosts({
      request: { query: 'needle', limit: 1, cursor },
      deps
    })
    expect(evicted.kind).toBe('stale-cursor')
  })
})

describe('all-hosts aggregate status', () => {
  it('sums counts and takes the highest generation', async () => {
    const local = fakeHost({ generation: 3, filesIndexed: 5 })
    const alpha = fakeHost({ generation: 11, filesIndexed: 2 })

    const status = await searchAllExecutionHostsStatus(hostDeps({ local, ssh: { alpha } }))

    expect(status).toMatchObject({
      enabled: true,
      phase: 'idle',
      filesIndexed: 7,
      generation: 11
    })
  })

  it('reports the absent-service sentinel when no host answers', async () => {
    const local = fakeHost({ statusFailure: true })

    expect(await searchAllExecutionHostsStatus(hostDeps({ local }))).toEqual(
      unavailableSessionSearchStatus()
    )
  })
})
