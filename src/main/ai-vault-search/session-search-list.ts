import type { AiVaultAgent, AiVaultSession } from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import type SyncDatabase from '../sqlite/sync-database'
import { parseVaultQuery } from '../../shared/ai-vault-session-filters'
import { sessionRowFilter } from './session-search-row-filter'

/**
 * Agent Session History's list, answered from the metadata tier.
 *
 * Why this exists: the panel used to be a filesystem walk plus a parse of every
 * transcript it found, so a load cost O(corpus) in readdirs, stats and reads on
 * every scan. The index already holds one row per session with everything a row
 * renders, which makes a load one indexed read instead.
 *
 * The scope filter is the search path's own `sessionRowFilter`, not a second
 * spelling of it: `path:`/`scopePaths` semantics, the `cwd_key` prefix range and
 * the retention subquery have to mean one thing in both surfaces, and the row
 * filter is where that is already decided.
 *
 * One consequence worth stating: a row is what the index saw at its last pass,
 * not a fresh stat. The scanner's answer was a filesystem verification and this
 * one is not, which is why the host only lists from here once a pass has
 * completed (see the instance) and why live sessions are unioned in by the
 * caller rather than waited for.
 */

/** A `sessions` row as the list reads it. */
type IndexedSessionRow = {
  id: number
  agent: AiVaultAgent
  session_id: string
  file_path: string
  codex_home: string | null
  title: string
  cwd: string | null
  branch: string | null
  model: string | null
  created_at: string | null
  updated_at: string | null
  modified_at: string | null
  message_count: number
  total_tokens: number
  queued_message_count: number
  subagent_transcript_count: number
  resume_command: string
}

export type IndexedSessionListArgs = {
  /** `Number.POSITIVE_INFINITY` for the panel's "unlimited" depth. */
  limit: number
  scopePaths?: readonly string[]
  agents?: readonly AiVaultAgent[]
  /** ISO instant; only sessions updated at or after it. */
  since?: string
  /**
   * Plain-text filter over the metadata search surface (title, cwd, branch,
   * agent). Operators never arrive here — see `aiVaultHostListQuery`; a caller
   * that cannot key one filters client-side instead of asking a different
   * question.
   */
  query?: string
  /** The host whose index this is. Stamped here because the DB is per host. */
  executionHostId: ExecutionHostId
  /** Retention window, so a listing cannot show what a purge is about to remove. */
  retentionCutoffMs?: number | null
}

export type IndexedSessionList = {
  sessions: AiVaultSession[]
  /** More sessions exist than the cap returned; the caller may show a "more" affordance. */
  truncated: boolean
}

const COLUMNS = `id, agent, session_id, file_path, codex_home, title, cwd, branch, model,
  created_at, updated_at, modified_at, message_count, total_tokens, queued_message_count,
  subagent_transcript_count, resume_command`

/**
 * The columns the panel's own filter searches, minus preview text.
 *
 * Why substring (`LIKE`) and not the metadata FTS table: the tokenizer keeps
 * `_`, `.`, `-` and `/` inside a token, so a cwd is one token `/repo/app` and a
 * user typing `app` or `repo/app` would find nothing — while the panel's
 * client-side filter, and the search box this replaced, both match it. Same
 * columns, same all-terms rule, same answer. `sessions_fts` stays for the ranked
 * search surface, where token semantics are what a hit is ranked on.
 */
const QUERY_COLUMNS = [
  'title',
  'session_id',
  'agent',
  'branch',
  'model',
  'cwd',
  'file_path'
] as const

/**
 * One term as a substring pattern, with the wildcards `LIKE` would otherwise read
 * out of the text escaped: a folder called `100%_done` must not match everything.
 */
function escapeLikePattern(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`)
}

/**
 * Newest first, one indexed read.
 *
 * `updated_at IS NULL` is excluded on purpose: that is a session a chunked read
 * has committed but not finished decoding, which has no title, cwd or times yet.
 * Today's scanner never returned a half-read session, and a row that renders as
 * blanks is worse than one that appears a pass later.
 */
export function listIndexedSessions(
  db: SyncDatabase,
  args: IndexedSessionListArgs
): IndexedSessionList {
  const filter = sessionRowFilter(
    {
      ...(args.agents && args.agents.length > 0 ? { agents: args.agents } : {}),
      ...(args.scopePaths && args.scopePaths.length > 0 ? { scopePaths: args.scopePaths } : {}),
      ...(args.since ? { since: args.since } : {})
    },
    args.retentionCutoffMs ?? null
  )
  const conditions = [...filter.conditions, 'updated_at IS NOT NULL']
  const values = [...filter.values]
  if (args.query) {
    // Every term must appear, which is the rule the client's own filter applies;
    // `parseVaultQuery` is that filter's parser, so operator text is already gone.
    for (const term of parseVaultQuery(args.query).terms) {
      const pattern = `%${escapeLikePattern(term)}%`
      conditions.push(
        `(${QUERY_COLUMNS.map((column) => `${column} LIKE ? ESCAPE '\\'`).join(' OR ')})`
      )
      values.push(...QUERY_COLUMNS.map(() => pattern))
    }
  }
  const unlimited = !Number.isFinite(args.limit)
  // One extra row is the whole truncation report: it proves more exist without
  // counting them, which on a large profile is the difference between a range
  // scan and a full one.
  const bound = unlimited ? -1 : Math.max(1, Math.floor(args.limit)) + 1
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the sessions schema defines IndexedSessionRow, and the SELECT lists its columns by name.
  const rows = db
    .prepare(
      `SELECT ${COLUMNS} FROM sessions WHERE ${conditions.join(' AND ')}
       ORDER BY updated_at DESC, id DESC LIMIT ?`
    )
    .all(...values, bound) as IndexedSessionRow[]
  const kept = unlimited ? rows : rows.slice(0, Math.max(0, Math.floor(args.limit)))
  return {
    sessions: kept.map((row) => indexedRowToSession(row, args.executionHostId)),
    truncated: !unlimited && rows.length > kept.length
  }
}

/**
 * The scanner's own row shape, so nothing downstream can tell which answered.
 *
 * `previewMessages` is empty and the prompt fields are absent: those are
 * transcript text, which the metadata tier does not store. They are read on
 * demand for the one session a user opens, which is what keeps a list load from
 * reading transcripts at all.
 */
function indexedRowToSession(
  row: IndexedSessionRow,
  executionHostId: ExecutionHostId
): AiVaultSession {
  return {
    id: `${executionHostId}:${row.agent}:${row.session_id}:${row.file_path}`,
    executionHostId,
    agent: row.agent,
    sessionId: row.session_id,
    title: row.title,
    cwd: row.cwd,
    branch: row.branch,
    model: row.model,
    filePath: row.file_path,
    codexHome: row.codex_home,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    modifiedAt: row.modified_at ?? row.updated_at ?? row.created_at ?? '',
    messageCount: row.message_count,
    totalTokens: row.total_tokens,
    previewMessages: [],
    queuedMessageCount: row.queued_message_count,
    subagentTranscriptCount: row.subagent_transcript_count,
    resumeCommand: row.resume_command,
    subagent: null
  }
}
