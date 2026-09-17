import type SyncDatabase from '../sqlite/sync-database'
import type { SessionSearchRoute } from './session-search-engine-types'
import type { SessionRow } from './session-search-hit-ranking'
import {
  andExpression,
  orExpression,
  phraseExpression,
  type SessionSearchQueryPlan
} from './session-search-query-planner'
import type { RetrievalScope } from './session-search-retrieval'

// Ids per `loadSessions` statement, with room to spare for the filter's own
// bound values beside them. Matches the content path's batch size deliberately:
// one query must not answer differently depending on the tier that ran it.
const SESSION_ID_BATCH = 500

type ScoredRow = {
  session_row_id: number
  score: number
}

/** One metadata match: the session, and the bm25 score that ranked it. */
export type MetadataMatch = {
  session: SessionRow
  score: number
}

export type MetadataRetrieved = {
  /** Already in ranked order: the SQL ranked it and nothing re-sorts it. */
  matches: MetadataMatch[]
  incomplete: boolean
  route: SessionSearchRoute
  plan: SessionSearchQueryPlan
}

/**
 * The metadata tier's retrieval: `sessions_fts` (title, cwd, branch, agent)
 * joined to `sessions`, and the answer when transcript content is not consented
 * to. `messages_fts` is empty in that state, so the content ladder would return
 * nothing for a query that a title or a path does answer.
 *
 * The content path's ladder without the typo repair, which reads a message
 * vocabulary that an index with no content tiers never fills. Every hit is a
 * session and never a message, so nothing here can carry transcript evidence.
 */
export class SessionSearchMetadataRetrieval {
  constructor(private readonly db: SyncDatabase) {}

  /**
   * The same route ladder the content path runs: phrase, then AND for a
   * literal-looking query, then OR. Repair is deliberately absent — it is a
   * content-only rung, and a metadata answer should report the plain route
   * rather than one the engine never ran.
   */
  run(plan: SessionSearchQueryPlan, scope: RetrievalScope): MetadataRetrieved {
    let incomplete = false
    let matches: MetadataMatch[] = []
    const match = (expression: string): MetadataMatch[] => {
      const rows = this.match(expression, scope)
      incomplete ||= rows.length >= scope.candidateLimit
      matches = this.loadSessions(rows, scope)
      return matches
    }
    const exact = this.literal(plan, match)
    if (exact) {
      return { matches: exact.matches, incomplete, route: exact.route, plan }
    }
    return { matches: match(orExpression(plan.terms)), incomplete, route: 'or', plan }
  }

  /** Phrase, then AND, for literal-looking queries; null when neither matches. */
  private literal(
    plan: SessionSearchQueryPlan,
    match: (expression: string) => MetadataMatch[]
  ): { matches: MetadataMatch[]; route: 'phrase' | 'and' } | null {
    if (!plan.literal || plan.body.length === 0) {
      return null
    }
    // A one-token literal (`src/a/b.ts`, `feature/x`) is its own phrase: the
    // tokenizer keeps it whole, so the exact token is the precise first try.
    const phrase = match(phraseExpression(plan.body))
    if (phrase.length > 0) {
      return { matches: phrase, route: 'phrase' }
    }
    if (plan.body.length < 2) {
      return null
    }
    const and = match(andExpression(plan.body))
    return and.length > 0 ? { matches: and, route: 'and' } : null
  }

  /**
   * `-bm25` like the content path selects it, so higher is better and a session
   * is still one row. Then the same `updated_at DESC, id DESC` total order
   * `recent()` walks: a cursor is an offset into this list, so two equal scores
   * must not be free to swap between pages.
   */
  private match(expression: string, scope: RetrievalScope): ScoredRow[] {
    const { filter, sort, candidateLimit } = scope
    // The filter's conditions run in a subquery over `sessions` alone because
    // `agent` and `cwd` name columns on both tables; unqualified, they would be
    // ambiguous. The join itself is the reachability check: an FTS row with no
    // session row behind it is unreadable, exactly as it is for messages.
    const eligible = filter.conditions.length
      ? ` AND s.id IN (SELECT id FROM sessions WHERE ${filter.conditions.join(' AND ')})`
      : ''
    const order =
      sort === 'newest'
        ? 's.updated_at DESC, score DESC, s.id DESC'
        : 'score DESC, s.updated_at DESC, s.id DESC'
    const sql = `SELECT sessions_fts.rowid AS session_row_id, -bm25(sessions_fts) AS score
      FROM sessions_fts JOIN sessions s ON s.id = sessions_fts.rowid
      WHERE sessions_fts MATCH ?${eligible} ORDER BY ${order} LIMIT ${candidateLimit}`
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the SELECT aliases exactly these two columns, and SQLite cannot type its own rows.
    return this.db.prepare(sql).all(expression, ...filter.values) as ScoredRow[]
  }

  /**
   * The full rows, in the SQL's ranked order, with the filters applied again.
   * The order is carried across the load rather than re-derived, because bm25
   * is the ranking and `sessions` carries no score to sort by.
   */
  private loadSessions(rows: readonly ScoredRow[], scope: RetrievalScope): MetadataMatch[] {
    const byId = new Map<number, SessionRow>()
    for (let start = 0; start < rows.length; start += SESSION_ID_BATCH) {
      const ids = rows.slice(start, start + SESSION_ID_BATCH).map((row) => row.session_row_id)
      const conditions = [`id IN (${ids.map(() => '?').join(',')})`, ...scope.filter.conditions]
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over sessions is the schema's own row shape, and nothing else writes that table.
      const batch = this.db
        .prepare(`SELECT * FROM sessions WHERE ${conditions.join(' AND ')}`)
        .all(...ids, ...scope.filter.values) as SessionRow[]
      for (const row of batch) {
        byId.set(row.id, row)
      }
    }
    const matches: MetadataMatch[] = []
    for (const row of rows) {
      const session = byId.get(row.session_row_id)
      // A session `repo:` / `path:` rejects leaves a gap instead of promoting
      // the next row: reordering here would break the bm25 order the SQL set.
      if (session && scope.matchesOperators(session)) {
        matches.push({ session, score: row.score })
      }
    }
    return matches
  }
}
