import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { AiVaultSearchHit } from '../../shared/ai-vault-search-types'

/**
 * Reciprocal rank fusion constant, from the original RRF paper. 60 damps the
 * top-rank advantage enough that a session two hosts rank well outranks one that
 * a single host ranks first, which is the point of fusing at all.
 */
export const SESSION_SEARCH_FUSION_K = 60

/** One host's ranked page, in that host's own order: rank 1 first. */
export type HostRankedHits = {
  executionHostId: string
  hits: readonly AiVaultSearchHit[]
}

type FusedGroup = {
  /** RRF sum over every host that returned this session. */
  score: number
  hit: AiVaultSearchHit
  executionHostId: string
  updatedAtMs: number
}

const SOURCE_PRESENCE_RANK = { present: 2, unverifiable: 1, missing: 0 } as const

/**
 * Fuse per-host rankings into one total order.
 *
 * BM25 scores are per-corpus and comparable only within a host, so ranks are the
 * only thing that crosses this boundary. Rows are deduped after fusion on
 * `(agent, sessionId, cwd)` — never on `filePath`, which a relay transport
 * withholds — and the surviving row is the leg `prefersLeg` picks.
 */
export function fuseHostRankings(legs: readonly HostRankedHits[]): AiVaultSearchHit[] {
  const groups = new Map<string, FusedGroup>()
  for (const leg of legs) {
    leg.hits.forEach((hit, index) => {
      const key = sessionSearchDedupeKey(hit)
      const contribution = 1 / (SESSION_SEARCH_FUSION_K + index + 1)
      const existing = groups.get(key)
      if (!existing) {
        groups.set(key, {
          score: contribution,
          hit: { ...hit, executionHostId: leg.executionHostId },
          executionHostId: leg.executionHostId,
          updatedAtMs: sessionUpdatedAtMs(hit)
        })
        return
      }
      existing.score += contribution
      if (prefersLeg(hit, leg.executionHostId, existing)) {
        existing.hit = { ...hit, executionHostId: leg.executionHostId }
        existing.executionHostId = leg.executionHostId
      }
    })
  }
  return (
    [...groups.values()]
      .sort(compareFusedGroups)
      // The merged score is the RRF sum: a per-host BM25 number means nothing here.
      .map((group) => ({ ...group.hit, score: group.score }))
  )
}

/**
 * Identity across hosts. `cwd` is in the key deliberately: a native-Windows and
 * a WSL view of one transcript spell the same folder differently, so they stay
 * two rows rather than one wrong one (a documented limitation, not a silent one).
 */
function sessionSearchDedupeKey(hit: AiVaultSearchHit): string {
  return JSON.stringify([hit.agent, hit.sessionId, hit.cwd ?? null])
}

/** Newest-first on the fused score; the rest makes the order total and stable. */
function compareFusedGroups(a: FusedGroup, b: FusedGroup): number {
  if (a.score !== b.score) {
    return b.score - a.score
  }
  if (a.updatedAtMs !== b.updatedAtMs) {
    return a.updatedAtMs < b.updatedAtMs ? 1 : -1
  }
  if (a.executionHostId !== b.executionHostId) {
    return a.executionHostId < b.executionHostId ? -1 : 1
  }
  if (a.hit.sessionId !== b.hit.sessionId) {
    return a.hit.sessionId < b.hit.sessionId ? -1 : 1
  }
  return 0
}

function prefersLeg(hit: AiVaultSearchHit, hostId: string, existing: FusedGroup): boolean {
  const presence = SOURCE_PRESENCE_RANK[hit.source.presence]
  const existingPresence = SOURCE_PRESENCE_RANK[existing.hit.source.presence]
  if (presence !== existingPresence) {
    return presence > existingPresence
  }
  const local = hostId === LOCAL_EXECUTION_HOST_ID
  const existingLocal = existing.executionHostId === LOCAL_EXECUTION_HOST_ID
  if (local !== existingLocal) {
    return local
  }
  // Last resort only: a per-host score says nothing about another host's corpus.
  return hostId < existing.executionHostId
}

// An unparseable or absent time sorts last rather than throwing off the order.
function sessionUpdatedAtMs(hit: AiVaultSearchHit): number {
  if (!hit.updatedAt) {
    return Number.NEGATIVE_INFINITY
  }
  const parsed = Date.parse(hit.updatedAt)
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY
}
