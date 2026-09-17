import { vi } from 'vitest'
import type {
  AiVaultSearchHit,
  AiVaultSearchRequest,
  AiVaultSearchResponse
} from './ai-vault-search-types'
import { unavailableSessionSearchStatus } from './ai-vault-search-client'

export function searchHit(): AiVaultSearchHit {
  return {
    agent: 'codex',
    sessionId: 'host-session',
    title: 'Indexed conversation',
    cwd: '/host/folder',
    branch: null,
    updatedAt: null,
    messageCount: 2,
    score: 1,
    source: { presence: 'present', filePath: '/host/transcript.jsonl', codexHome: '/host/codex' },
    evidence: { role: 'user', timestamp: null, snippet: 'a [[needle]]' },
    resumeCommand: 'host-resume-command'
  }
}

export function searchResults(): Extract<AiVaultSearchResponse, { kind: 'results' }> {
  return {
    kind: 'results',
    hits: [searchHit()],
    page: { cursor: null, hasMore: false },
    generation: 7,
    truncated: { candidates: false, snippets: 0, query: false, freshness: false },
    durationMs: 1,
    debug: { route: 'phrase', plannerReport: { route: 'phrase', scope: 'all' } }
  }
}

/** Wire-shaped hit with overridable fields, for cross-host merge tests. */
export function aiVaultSearchHit(overrides: Partial<AiVaultSearchHit> = {}): AiVaultSearchHit {
  const base = searchHit()
  const presence = overrides.source?.presence ?? base.source.presence
  return {
    ...base,
    // The wire schema refuses a resume command on a non-present source.
    ...(presence === 'present' ? {} : { resumeCommand: undefined }),
    ...overrides
  }
}

export function aiVaultSearchResults(
  args: {
    hits?: AiVaultSearchHit[]
    generation?: number
    hasMore?: boolean
    truncated?: Partial<Extract<AiVaultSearchResponse, { kind: 'results' }>['truncated']>
  } = {}
): Extract<AiVaultSearchResponse, { kind: 'results' }> {
  const base = searchResults()
  return {
    kind: 'results',
    hits: args.hits ?? base.hits,
    page: { cursor: null, hasMore: args.hasMore ?? false },
    generation: args.generation ?? base.generation,
    truncated: { ...base.truncated, ...args.truncated },
    durationMs: base.durationMs
  }
}

export function fakeSearchService() {
  return {
    search: vi.fn(
      async (
        _request: AiVaultSearchRequest,
        // The host's scope verdict, declared so `mock.calls` records it. Typed
        // loosely because its type is a host-side one and this fixture is shared.
        _hostScope?: unknown
      ): Promise<AiVaultSearchResponse> => searchResults()
    ),
    status: vi.fn(async () => ({
      ...unavailableSessionSearchStatus(),
      enabled: true,
      generation: 7
    })),
    reconcile: vi.fn(async () => {})
  }
}
