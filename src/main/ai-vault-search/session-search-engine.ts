import type SyncDatabase from '../sqlite/sync-database'
import { sliceAtCodeUnitLimit } from '../ai-vault/session-scanner-text-normalization'
import {
  hasAiVaultSearchQueryOperators,
  splitAiVaultSearchQuery,
  type AiVaultSearchQuerySplit
} from '../../shared/ai-vault/search/ai-vault-search-query-operators'
import { matchesAiVaultQueryOperators } from '../../shared/ai-vault/session-display/ai-vault-session-filters'
import {
  SESSION_SEARCH_QUERY_MAX_LENGTH,
  type SessionSearchRequest,
  type SessionSearchResponse,
  type SessionSearchScope
} from './session-search-engine-types'
import { resolveSessionSearchLimit } from '../../shared/ai-vault/search/ai-vault-search-limit'
import {
  readIndexContentRevision,
  readIndexGeneration,
  readIndexIncarnation
} from './session-search-index-generation'
import {
  rankSessionHits,
  type MessageRow,
  type RankedSession,
  type SessionRow
} from './session-search-hit-ranking'
import {
  decodeSessionSearchCursor,
  encodeSessionSearchCursor,
  sessionSearchPageKey
} from './session-search-page-cursor'
import {
  SESSION_SEARCH_MAX_CANDIDATES,
  decodeRankedSessionSearchCursor,
  encodeRankedSessionSearchCursor,
  type SessionSearchRankedCursor
} from './session-search-ranked-cursor'
import { planSessionSearchQuery } from './session-search-query-planner'
import { SessionSearchRetrieval, type RetrievalScope } from './session-search-retrieval'
import { SessionSearchMetadataRetrieval } from './session-search-metadata-retrieval'
import {
  buildMetadataRankedPage,
  buildSessionSearchHits,
  type RankedPage
} from './session-search-hit-builder'
import { readSessionSearchContentConsent } from './session-search-store'

import { sessionRowFilter } from './session-search-row-filter'
import { ensureSessionSearchQuerySchema } from './session-search-query-schema'

/** Candidate-limit tuning and measurements: docs/reference/agent-session-search-query-tuning.md. */
export const SESSION_SEARCH_CANDIDATE_LIMIT_DEFAULT = 600

export type SessionSearchEngineOptions = {
  sessionCandidateLimit?: number
  /** Oldest eligible transcript mtime, derived from retention. */
  retentionCutoffMs?: number | null
  /**
   * Whether transcript content is consented to. False means `messages_fts` was
   * never filled, so a text query is answered from `session_metadata_fts` instead.
   */
  contentEnabled?: boolean
}

/** One page reads one WAL snapshot; later page requests still validate their generation. */
export class SessionSearchEngine {
  private readonly retrieval: SessionSearchRetrieval
  private readonly metadataRetrieval: SessionSearchMetadataRetrieval
  private readonly candidateLimit: number
  private readonly contentEnabled: boolean

  constructor(
    private readonly db: SyncDatabase,
    private readonly options: SessionSearchEngineOptions = {}
  ) {
    this.candidateLimit = Math.min(
      SESSION_SEARCH_MAX_CANDIDATES,
      options.sessionCandidateLimit ?? SESSION_SEARCH_CANDIDATE_LIMIT_DEFAULT
    )
    // Default on: an engine that was not told otherwise takes the consent the
    // index recorded, so a worker opened without the setting still answers from
    // the metadata surface while content is off.
    this.contentEnabled = options.contentEnabled ?? readSessionSearchContentConsent(db)
    // Installed here and not on the first search, so the generation triggers are
    // watching before anything this engine will be asked to page over is
    // written, and so retrieval below prepares against tables that exist.
    ensureSessionSearchQuerySchema(this.db)
    this.retrieval = new SessionSearchRetrieval(this.db)
    this.metadataRetrieval = new SessionSearchMetadataRetrieval(this.db)
  }

  generation(): number {
    return readIndexGeneration(this.db)
  }

  search(request: SessionSearchRequest): SessionSearchResponse {
    this.db.exec('BEGIN')
    try {
      const result = this.readPage(request)
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private readPage(request: SessionSearchRequest): SessionSearchResponse {
    const startedAt = performance.now()
    ensureSessionSearchQuerySchema(this.db)
    const generation = readIndexGeneration(this.db)
    const incarnation = readIndexIncarnation(this.db)
    const scope = request.scope ?? 'all'
    const sort = request.filters?.sort ?? 'relevance'
    const capped = sliceAtCodeUnitLimit(request.query, SESSION_SEARCH_QUERY_MAX_LENGTH)
    const split = splitAiVaultSearchQuery(capped)
    const retrievalScope: RetrievalScope = {
      scope,
      sort,
      filter: sessionRowFilter(request.filters ?? {}, this.options.retentionCutoffMs ?? null),
      matchesOperators: operatorPredicate(split),
      candidateLimit: this.candidateLimit
    }
    // Reject invalid cursors before paying for retrieval.
    const pageKey = sessionSearchPageKey(request)
    const frozen = request.cursor
      ? decodeRankedSessionSearchCursor(
          request.cursor,
          generation,
          readIndexContentRevision(this.db, generation),
          pageKey,
          incarnation
        )
      : null
    if (frozen) {
      const limit = resolveSessionSearchLimit(request.limit)
      const page = this.retrieval.hydrate(
        frozen.hits.slice(frozen.o, frozen.o + limit),
        retrievalScope
      )
      return this.frozenPage(frozen, page, scope, limit, startedAt)
    }
    const offset = request.cursor
      ? decodeSessionSearchCursor(request.cursor, generation, pageKey, incarnation)
      : 0

    const plan = planSessionSearchQuery(split.text)
    let rankedPage: RankedPage
    if (plan.terms.length === 0) {
      rankedPage = this.operatorOnly(split, retrievalScope)
    } else if (this.contentEnabled) {
      rankedPage = this.text(plan, retrievalScope, sort)
    } else {
      rankedPage = buildMetadataRankedPage(this.metadataRetrieval, plan, retrievalScope)
    }
    const { ranked, retrieved, incomplete } = rankedPage

    const limit = resolveSessionSearchLimit(request.limit)
    const snapshot: SessionSearchRankedCursor = {
      v: 2,
      i: incarnation,
      g: generation,
      r: readIndexContentRevision(this.db, generation),
      k: pageKey,
      o: offset,
      hits: ranked.map((entry) => ({
        s: entry.session.id,
        m: entry.message?.rowid ?? null,
        score: entry.score,
        d: entry.duplicateCount
      })),
      retrieval: retrieved
        ? {
            plan: retrieved.plan,
            route: retrieved.route,
            ...(retrieved.repairedTerms ? { repairedTerms: retrieved.repairedTerms } : {})
          }
        : null,
      incomplete,
      queryTruncated: capped.length < request.query.length || plan.truncated
    }
    return this.frozenPage(
      snapshot,
      ranked.slice(offset, offset + limit),
      scope,
      limit,
      startedAt,
      !!request.cursor
    )
  }

  private frozenPage(
    frozen: SessionSearchRankedCursor,
    page: RankedSession[],
    scope: SessionSearchScope,
    limit: number,
    startedAt: number,
    legacy = false
  ): SessionSearchResponse {
    const hits = buildSessionSearchHits(this.db, page, scope, frozen.retrieval)
    const next = frozen.o + limit
    const hasMore = next < frozen.hits.length
    return {
      hits,
      planner: {
        route: frozen.retrieval?.route ?? 'or',
        tier: scope,
        ...(frozen.retrieval?.repairedTerms
          ? { repairedTerms: frozen.retrieval.repairedTerms }
          : {})
      },
      page: {
        hasMore,
        cursor: hasMore
          ? legacy
            ? encodeSessionSearchCursor(frozen.g, next, frozen.k, frozen.i)
            : encodeRankedSessionSearchCursor({ ...frozen, o: next })
          : null
      },
      truncated: {
        candidates: frozen.incomplete,
        query: frozen.queryTruncated,
        snippets: hits.filter((hit) => hit.evidence?.snippetTruncated).length
      },
      generation: frozen.g,
      durationMs: performance.now() - startedAt
    }
  }

  /** Operator-only queries use newest order and the same fork folding as text queries. */
  private operatorOnly(split: AiVaultSearchQuerySplit, scope: RetrievalScope): RankedPage {
    if (!hasAiVaultSearchQueryOperators(split)) {
      return { ranked: [], retrieved: null, incomplete: false }
    }
    const { sessions, incomplete } = this.retrieval.recent(scope)
    return { ranked: rankSessionHits(sessions, new Map(), 'newest'), retrieved: null, incomplete }
  }

  private text(
    plan: ReturnType<typeof planSessionSearchQuery>,
    scope: RetrievalScope,
    sort: 'relevance' | 'newest'
  ): RankedPage {
    const retrieved = this.retrieval.run(plan, scope)
    const best = new Map<number, MessageRow>()
    for (const row of retrieved.rows) {
      const previous = best.get(row.session_row_id)
      if (
        !previous ||
        row.score > previous.score ||
        (row.score === previous.score && row.rowid < previous.rowid)
      ) {
        best.set(row.session_row_id, row)
      }
    }
    const ranked = rankSessionHits(retrieved.sessions, best, sort)
    return {
      ranked: ranked.slice(0, this.candidateLimit),
      retrieved,
      incomplete: retrieved.incomplete || ranked.length >= this.candidateLimit
    }
  }
}

/** Reuse panel operator matching; repo labels fall back to folder labels without a project map. */
function operatorPredicate(split: AiVaultSearchQuerySplit): (session: SessionRow) => boolean {
  if (!hasAiVaultSearchQueryOperators(split)) {
    return () => true
  }
  return (session) =>
    matchesAiVaultQueryOperators(
      { cwd: session.cwd, filePath: session.file_path },
      { repoTerms: split.repoTerms, pathTerms: split.pathTerms }
    )
}
