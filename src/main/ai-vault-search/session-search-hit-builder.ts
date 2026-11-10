import type SyncDatabase from '../sqlite/sync-database'
import type { TranscriptMessageRole } from '../ai-vault/transcripts/session-transcript-consumers'
import type {
  SessionSearchHit,
  SessionSearchScope,
  SessionSearchSourcePresence
} from './session-search-engine-types'
import type { RankedSession, SessionRow } from './session-search-hit-ranking'
import type { SessionSearchMetadataRetrieval } from './session-search-metadata-retrieval'
import type { RetrievalScope, Retrieved } from './session-search-retrieval'
import type { planSessionSearchQuery } from './session-search-query-planner'
import { EMPTY_SNIPPET, sessionSearchSnippet } from './session-search-snippet'
import { sessionSourcePresence } from './session-search-source-presence'

export type SnippetPlan = Pick<Retrieved, 'plan' | 'route' | 'repairedTerms'>

export type RankedPage = {
  ranked: RankedSession[]
  retrieved: Retrieved | null
  /** Retrieval stopped at a candidate or operator-scan limit. */
  incomplete: boolean
}

/**
 * The metadata tier's answer: titles, paths, branches and agent names, with no
 * transcript text behind them. Reached only when content is not consented to,
 * where the content ladder would answer every text query with nothing.
 */
export function buildMetadataRankedPage(
  metadataRetrieval: SessionSearchMetadataRetrieval,
  plan: ReturnType<typeof planSessionSearchQuery>,
  scope: RetrievalScope
): RankedPage {
  const found = metadataRetrieval.run(plan, scope)
  return {
    // `message: null` is what keeps evidence out of a metadata hit: the hit
    // builder only reads a row when it has a message to snippet from, so a
    // metadata snippet is never fabricated here.
    ranked: found.matches.map((match) => ({
      session: match.session,
      message: null,
      score: match.score,
      duplicateCount: 1
    })),
    // No rows, and the ones the content path would rank by are absent on
    // purpose: bm25 already ordered this list in SQL.
    retrieved: {
      sessions: found.matches.map((match) => match.session),
      rows: [],
      incomplete: found.incomplete,
      route: found.route,
      plan: found.plan
    },
    incomplete: found.incomplete
  }
}

/** Snippets and source presence are paid for by the page, never by the list. */
export function buildSessionSearchHits(
  db: SyncDatabase,
  page: readonly RankedSession[],
  scope: SessionSearchScope,
  retrieved: SnippetPlan | null
): SessionSearchHit[] {
  const presence = sessionSourcePresence(
    db,
    page.map((entry) => entry.session.id)
  )
  return page.map((entry) => buildHit(db, entry, scope, retrieved, presence))
}

function buildHit(
  db: SyncDatabase,
  entry: RankedSession,
  scope: SessionSearchScope,
  retrieved: SnippetPlan | null,
  presence: ReadonlyMap<number, SessionSearchSourcePresence>
): SessionSearchHit {
  const { session, message } = entry
  const snippet =
    message && retrieved
      ? sessionSearchSnippet(db, scope, message.rowid, retrieved.plan, retrieved.route)
      : EMPTY_SNIPPET
  return {
    ...sessionFields(session),
    score: entry.score,
    ...(entry.duplicateCount > 1 ? { duplicateCount: entry.duplicateCount } : {}),
    source: presence.get(session.id) ?? 'unverifiable',
    evidence: message
      ? {
          role: message.role as TranscriptMessageRole,
          timestamp: message.ts,
          snippet: snippet.text,
          ...(snippet.truncated ? { snippetTruncated: true } : {})
        }
      : null
  }
}

function sessionFields(
  session: SessionRow
): Omit<SessionSearchHit, 'score' | 'evidence' | 'source' | 'duplicateCount'> {
  return {
    agent: session.agent,
    sessionId: session.session_id,
    filePath: session.file_path,
    codexHome: session.codex_home,
    title: session.title,
    cwd: session.cwd,
    branch: session.branch,
    updatedAt: session.updated_at,
    messageCount: session.message_count,
    resumeCommand: session.resume_command
  }
}
