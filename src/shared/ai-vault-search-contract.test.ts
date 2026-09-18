import { describe, expect, it } from 'vitest'
import {
  AiVaultSearchHostOutcomeSchema,
  AiVaultSearchRequestSchema,
  AiVaultSearchResponseSchema,
  AiVaultSearchStatusSchema
} from './ai-vault-search-contract'
import { searchHit, searchResults } from './ai-vault-search-test-fixture'
import { redactForTransport, redactStatusForTransport } from './ai-vault-search-transport'
import { createSessionSearchClient, unavailableSessionSearchStatus } from './ai-vault-search-client'

describe('session search public contract', () => {
  it('drops legacy fields without letting them override scope or freshness', () => {
    expect(
      AiVaultSearchRequestSchema.parse({ query: 'needle', tier: 'conversation', refresh: true })
    ).toEqual({ query: 'needle', limit: 20 })
  })
  it.each([
    [0, 1],
    [-4, 1],
    [200, 100],
    [2.5, 20],
    [undefined, 20]
  ])('clamps %s to %s', (limit, expected) => {
    expect(AiVaultSearchRequestSchema.parse({ query: 'needle', limit }).limit).toBe(expected)
  })
  it('allows the engine to report long-query truncation', () => {
    const query = 'needle '.repeat(100)
    expect(AiVaultSearchRequestSchema.parse({ query }).query).toBe(query)
  })
  it('validates every response variant and separate status', () => {
    for (const response of [
      searchResults(),
      { kind: 'malformed-cursor' },
      { kind: 'stale-cursor', generation: 2, expectedGeneration: 1 },
      ...['disabled', 'not-ready', 'no-service'].map((reason) => ({ kind: 'unavailable', reason }))
    ]) {
      expect(AiVaultSearchResponseSchema.parse(response)).toEqual(response)
    }
    expect(AiVaultSearchStatusSchema.parse(unavailableSessionSearchStatus())).toEqual(
      unavailableSessionSearchStatus()
    )
    expect(AiVaultSearchResponseSchema.safeParse({ kind: 'results', hits: [] }).success).toBe(false)
  })
  it('keeps host attribution optional in both wire directions', () => {
    const legacy = searchResults()
    expect(AiVaultSearchResponseSchema.parse(legacy)).toEqual(legacy)
    expect(legacy.hits[0]).not.toHaveProperty('executionHostId')
    const attributed = {
      ...searchResults(),
      hits: [{ ...searchHit(), executionHostId: 'runtime:env-1' }]
    }
    expect(AiVaultSearchResponseSchema.parse(attributed)).toEqual(attributed)
    expect(
      AiVaultSearchResponseSchema.safeParse({
        ...searchResults(),
        hits: [{ ...searchHit(), executionHostId: '' }]
      }).success
    ).toBe(false)
  })
  it('never accepts resume commands for an unverified or missing source', () => {
    for (const presence of ['unverifiable', 'missing'] as const) {
      const response = searchResults()
      response.hits[0].source.presence = presence
      expect(AiVaultSearchResponseSchema.safeParse(response).success).toBe(false)
    }
  })
  it.each(['ipc', 'runtime', 'relay'] as const)(
    'enforces the %s exposure policy without mutating the hit',
    (transport) => {
      const hit = searchHit()
      const original = structuredClone(hit)
      const result = redactForTransport(hit, transport)
      expect(hit).toEqual(original)
      expect(result.cwd).toBe('/host/folder')
      if (transport === 'relay') {
        expect(result.source).toEqual({ presence: 'present' })
        expect(result).not.toHaveProperty('resumeCommand')
      } else {
        expect(result).toEqual(hit)
      }
      for (const presence of ['unverifiable', 'missing'] as const) {
        expect(
          redactForTransport({ ...hit, source: { ...hit.source, presence } }, transport)
        ).not.toHaveProperty('resumeCommand')
      }
    }
  )
  it.each(['ipc', 'runtime', 'relay'] as const)(
    'withholds degraded-root paths from %s status without mutating it',
    (transport) => {
      const status = {
        ...unavailableSessionSearchStatus(),
        degradedRoots: [{ root: '/host/projects', reason: 'could not be listed' }]
      }
      const original = structuredClone(status)
      const result = redactStatusForTransport(status, transport)
      expect(status).toEqual(original)
      expect(AiVaultSearchStatusSchema.parse(result)).toEqual(result)
      expect(result.degradedRoots).toEqual([
        transport === 'relay'
          ? { reason: 'Source root could not be verified.' }
          : { root: '/host/projects', reason: 'could not be listed' }
      ])
    }
  )
  it.each([
    '/host/private/path could not be listed.',
    "EACCES: permission denied, scandir '/host/private/path'",
    "EACCES: permission denied, scandir 'C:\\Users\\private\\sessions'"
  ])('withholds paths embedded in relay diagnostics: %s', (reason) => {
    const status = {
      ...unavailableSessionSearchStatus(),
      degradedRoots: [{ root: '/host/private/path', reason }]
    }
    const result = redactStatusForTransport(status, 'relay')
    expect(result.degradedRoots).toHaveLength(1)
    expect(JSON.stringify(result)).not.toContain('/host/private/path')
    expect(JSON.stringify(result)).not.toContain('private')
    expect(redactStatusForTransport(status, 'runtime')).toEqual(status)
  })
})

// Clients and hosts update independently, and the two directions fail
// differently: an old host omits the additive merged-page fields, while a newer
// host may add fields this build cannot name. Neither may fail the decode — see
// docs/reference/remote-wire-compatibility.md.
describe('session search cross-version skew', () => {
  it('accepts an old host answer that predates the merged-page fields', () => {
    const legacy = searchResults()
    const parsed = AiVaultSearchResponseSchema.parse(legacy)
    expect(parsed).toEqual(legacy)
    expect(parsed).not.toHaveProperty('hosts')

    // A host that predates the metadata/content split reports no consent either.
    const status = unavailableSessionSearchStatus()
    const parsedStatus = AiVaultSearchStatusSchema.parse(status)
    expect(parsedStatus).toEqual(status)
    expect(parsedStatus).not.toHaveProperty('contentEnabled')
  })

  it('strips additive and unknown fields from a newer host instead of rejecting them', () => {
    const response = {
      ...searchResults(),
      hosts: [{ executionHostId: 'runtime:box', outcome: 'searched' }],
      futureField: { nested: true }
    }
    const parsed = AiVaultSearchResponseSchema.parse(response)
    expect(parsed).not.toHaveProperty('futureField')
    expect(parsed.kind === 'results' && parsed.hosts).toEqual([
      { executionHostId: 'runtime:box', outcome: 'searched' }
    ])

    const status = { ...unavailableSessionSearchStatus(), contentEnabled: true, futureField: 1 }
    const parsedStatus = AiVaultSearchStatusSchema.parse(status)
    expect(parsedStatus).not.toHaveProperty('futureField')
    expect(parsedStatus.contentEnabled).toBe(true)
  })

  it('records a known per-host outcome, never an invented one', () => {
    const hosts = [
      { executionHostId: 'runtime:box', outcome: 'searched' },
      { executionHostId: 'ssh:box', outcome: 'unreachable' }
    ]
    const parsed = AiVaultSearchResponseSchema.parse({ ...searchResults(), hosts })
    expect(parsed.kind === 'results' && parsed.hosts).toEqual(hosts)
    expect(
      AiVaultSearchResponseSchema.safeParse({
        ...searchResults(),
        hosts: [{ executionHostId: 'runtime:box', outcome: 'invented' }]
      }).success
    ).toBe(false)
    expect(
      AiVaultSearchHostOutcomeSchema.safeParse({ executionHostId: '', outcome: 'searched' }).success
    ).toBe(false)
  })

  it('keeps truncated.freshness required, as every released host has sent it', () => {
    // Why: freshness shipped with the contract's first commit, so no host in the
    // rolling-upgrade window omits it; defaulting it would invent freshness.
    expect(
      AiVaultSearchResponseSchema.safeParse({
        ...searchResults(),
        truncated: { candidates: false, snippets: 0, query: false }
      }).success
    ).toBe(false)
  })

  it('passes a newer host per-host report through relay redaction without depending on it', async () => {
    const response = {
      ...searchResults(),
      hosts: [{ executionHostId: 'runtime:box', outcome: 'unreachable' }]
    }
    const client = createSessionSearchClient(async () => response, 'relay')
    const result = await client.searchSessions({ query: 'needle' })
    if (result.kind !== 'results') {
      throw new Error('expected a results page')
    }
    expect(result.hosts).toEqual(response.hosts)
    expect(result.hits[0]).not.toHaveProperty('resumeCommand')
    expect(result.hits[0]?.source).toEqual({ presence: 'present' })
  })

  it('does not invent a per-host report for an old host answer or a status without consent', async () => {
    const client = createSessionSearchClient(
      async (method) =>
        method === 'aiVault.searchStatus' ? unavailableSessionSearchStatus() : searchResults(),
      'ipc'
    )
    const result = await client.searchSessions({ query: 'needle' })
    expect(result).not.toHaveProperty('hosts')
    expect(await client.searchStatus()).not.toHaveProperty('contentEnabled')
  })
})
