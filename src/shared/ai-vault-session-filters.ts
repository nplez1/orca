// Keep filters in shared for mobile: Metro watches mobile and src/shared, never renderer. This shared leaf must not import renderer modules.
import {
  normalizeRuntimePathForComparison,
  normalizeRuntimePathSeparators
} from './cross-platform-path'
import { isClipboardTextByteLengthOverLimit } from './clipboard-text'
import {
  hasAiVaultSearchQueryOperators,
  splitAiVaultSearchQuery
} from './ai-vault-search-query-operators'
import { aiVaultSessionInScope, createAiVaultScopeCwdMatcher } from './ai-vault-scope-cwd-match'
import type {
  AiVaultAgent,
  AiVaultGroup,
  AiVaultScope,
  AiVaultSession,
  AiVaultSort
} from './ai-vault-types'
import {
  aiVaultAgentLabel,
  isAiVaultSessionRecoverableEmpty,
  isAiVaultSessionResumableContent
} from './ai-vault-types'
import type { ExecutionHostId } from './execution-host'
import { sessionPreviewSearchText } from './ai-vault-session-display'

// Move the plain descriptor type without importing renderer project-attribution runtime.
export type AiVaultSessionProject = {
  kind: 'repo' | 'folder' | 'unknown'
  key: string
  label: string
  projectId?: string
  repoId?: string
  hostKey?: ExecutionHostId
}

export type AiVaultSessionFilterState = {
  query: string
  agents: readonly AiVaultAgent[]
  scope: AiVaultScope
  sort: AiVaultSort
  activeWorktreePaths: readonly string[]
  activeProjectKey?: string | null
  sessionProjectById?: ReadonlyMap<string, AiVaultSessionProject>
  projectLabelByKey?: ReadonlyMap<string, string>
  hideEmptySessions: boolean
}

export type AiVaultSessionGroup = {
  key: string
  label: string
  sessions: AiVaultSession[]
}

type ParsedQuery = {
  terms: string[]
  repoTerms: string[]
  pathTerms: string[]
}

export const AI_VAULT_SESSION_FILTER_QUERY_MAX_BYTES = 2 * 1024

export function isAiVaultSessionFilterQueryTooLarge(
  query: string,
  maxBytes = AI_VAULT_SESSION_FILTER_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}

/**
 * The query a host may apply to a listing: plain text only, within the byte bound.
 *
 * Empty means "the client filters this itself", which is what every operator
 * query gets. `repo:` needs the client's own project mapping and `path:` reads the
 * panel's predicate (`matchesAiVaultQueryOperators`), so a host cannot answer
 * either one and must not silently answer a different question than the one the
 * panel will show. Both sides call this, so what the client sends and what the
 * host accepts cannot drift.
 */
export function aiVaultHostListQuery(query: string): string {
  const trimmed = query.trim()
  if (trimmed.length === 0 || isAiVaultSessionFilterQueryTooLarge(trimmed)) {
    return ''
  }
  return hasAiVaultSearchQueryOperators(splitAiVaultSearchQuery(trimmed)) ? '' : trimmed
}

/**
 * The text half of the panel's filter, for a host filtering a listing itself.
 *
 * Same rule as `termsMatch` — every term must appear in the row's own text — so a
 * host-filtered listing and a client-filtered one agree about what "matches" means.
 * Previews are deliberately absent, for the same reason: they are transcript text a
 * metadata answer does not carry. Operators are deliberately absent too: `repo:`
 * needs the client's project mapping and `path:` reads the panel's own predicate, so
 * a host that guessed at them would answer a question the panel never asked.
 */
export function aiVaultSessionsMatchingQuery(
  sessions: readonly AiVaultSession[],
  query: string
): AiVaultSession[] {
  const parsed = parseVaultQuery(query)
  return sessions.filter((session) => termsMatch(session, parsed.terms, false))
}

export function filterAiVaultSessions(
  sessions: readonly AiVaultSession[],
  filters: AiVaultSessionFilterState
): AiVaultSession[] {
  if (isAiVaultSessionFilterQueryTooLarge(filters.query)) {
    return []
  }

  const agentSet = new Set(filters.agents)
  const parsedQuery = parseVaultQuery(filters.query)
  const inWorkspace = createAiVaultScopeCwdMatcher(
    filters.scope === 'workspace' ? filters.activeWorktreePaths : []
  )

  const filtered = sessions.filter((session) => {
    if (!agentSet.has(session.agent)) {
      return false
    }
    // Hide only truly empty sessions; retain preview-inferred turns and queued/subagent recovery content so lost conversations remain visible.
    if (
      filters.hideEmptySessions &&
      !isAiVaultSessionResumableContent(session) &&
      !isAiVaultSessionRecoverableEmpty(session)
    ) {
      return false
    }
    if (filters.scope === 'workspace') {
      if (!aiVaultSessionInScope(inWorkspace, session)) {
        return false
      }
    }
    if (filters.scope === 'project') {
      if (!filters.activeProjectKey) {
        return false
      }
      if (filters.sessionProjectById?.get(session.id)?.key !== filters.activeProjectKey) {
        return false
      }
    }
    return matchesQuery(session, parsedQuery, filters)
  })
  if (filtered.length < 2) {
    return filtered
  }
  return filtered
    .map((session) => ({ session, time: sessionSortTime(session, filters.sort) }))
    .sort((left, right) => right.time - left.time)
    .map(({ session }) => session)
}

export function groupAiVaultSessions(
  sessions: readonly AiVaultSession[],
  group: AiVaultGroup,
  options: {
    sessionProjectById?: ReadonlyMap<string, AiVaultSessionProject>
    projectLabelByKey?: ReadonlyMap<string, string>
  } = {}
): AiVaultSessionGroup[] {
  const groups = new Map<string, AiVaultSessionGroup>()

  for (const session of sessions) {
    const { key, label } = getGroupIdentity(session, group, options)
    const existing = groups.get(key)
    if (existing) {
      existing.sessions.push(session)
    } else {
      groups.set(key, { key, label, sessions: [session] })
    }
  }

  return [...groups.values()]
}

export function folderLabel(pathValue: string | null): string {
  if (!pathValue) {
    return 'Unknown location'
  }
  // NFC so one folder renders the same header whichever spelling (macOS NFD vs
  // agent-recorded NFC) reaches the group first.
  const parts = normalizeRuntimePathSeparators(pathValue.normalize('NFC'))
    .split('/')
    .filter(Boolean)
  if (parts.length >= 2) {
    return parts.slice(-2).join('/')
  }
  return parts[0] ?? pathValue
}

/** Normalize trailing separators and NFD/NFC without folding distinct POSIX case-sensitive folders. Match folder: project keys so fallback and project grouping agree. */
export function folderGroupKey(pathValue: string | null): string {
  return pathValue ? `folder:${normalizeRuntimePathForComparison(pathValue)}` : 'unknown'
}

export function agentLabel(agent: AiVaultAgent): string {
  return aiVaultAgentLabel(agent)
}

/** Delegate operators to the index's shared parser; fold values here for panel matching while the index retains original case. */
export function parseVaultQuery(query: string): ParsedQuery {
  const split = splitAiVaultSearchQuery(query)
  const fold = (values: readonly string[]): string[] => values.map((value) => value.toLowerCase())
  return {
    terms: fold(split.terms),
    repoTerms: fold(split.repoTerms),
    pathTerms: fold(split.pathTerms)
  }
}

/** What `repo:` and `path:` are compared against for one session. */
export type AiVaultQueryOperatorTarget = {
  cwd: string | null
  filePath: string
  /** Prefer the resolved project label; fall back to the last two path segments. */
  repoLabel?: string
}

/** Apply conjunctive repo/path matching after indexed retrieval: SQL LIKE folds only ASCII and path also covers transcript paths, so SQL cannot express the shared semantics. */
export function matchesAiVaultQueryOperators(
  target: AiVaultQueryOperatorTarget,
  operators: { repoTerms: readonly string[]; pathTerms: readonly string[] }
): boolean {
  if (operators.repoTerms.length > 0) {
    const repoLabel = (target.repoLabel ?? folderLabel(target.cwd)).toLowerCase()
    if (operators.repoTerms.some((term) => !repoLabel.includes(term.toLowerCase()))) {
      return false
    }
  }
  if (operators.pathTerms.length > 0) {
    const pathSearch = `${target.cwd ?? ''} ${target.filePath}`.toLowerCase()
    if (operators.pathTerms.some((term) => !pathSearch.includes(term.toLowerCase()))) {
      return false
    }
  }
  return true
}

/**
 * The term half of the panel's filter: every term must appear in the row's own text.
 *
 * `includePreviews` is false for a caller that filters rows a host produced, because
 * preview text is transcript content the metadata tier does not carry — including it
 * here would make the scanner fallback match rows the index path cannot, and which
 * path answered would then change what a search returns.
 */
function termsMatch(
  session: AiVaultSession,
  terms: readonly string[],
  includePreviews: boolean
): boolean {
  if (terms.length === 0) {
    return true
  }
  const searchable = [
    session.title,
    session.sessionId,
    session.agent,
    session.branch,
    session.model,
    session.cwd,
    session.filePath,
    ...(includePreviews ? [sessionPreviewSearchText(session)] : [])
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return terms.every((term) => searchable.includes(term))
}

function matchesQuery(
  session: AiVaultSession,
  parsed: ParsedQuery,
  filters: Pick<AiVaultSessionFilterState, 'sessionProjectById' | 'projectLabelByKey'>
): boolean {
  if (!termsMatch(session, parsed.terms, true)) {
    return false
  }
  const sessionProject = filters.sessionProjectById?.get(session.id)
  return matchesAiVaultQueryOperators(
    {
      cwd: session.cwd,
      filePath: session.filePath,
      repoLabel:
        sessionProject?.kind === 'repo'
          ? (filters.projectLabelByKey?.get(sessionProject.key) ?? sessionProject.label)
          : undefined
    },
    parsed
  )
}

function sessionSortTime(session: AiVaultSession, sort: AiVaultSort): number {
  const value = sort === 'created' ? session.createdAt : session.updatedAt
  return Date.parse(value ?? session.modifiedAt)
}

function getGroupIdentity(
  session: AiVaultSession,
  group: AiVaultGroup,
  options: {
    sessionProjectById?: ReadonlyMap<string, AiVaultSessionProject>
    projectLabelByKey?: ReadonlyMap<string, string>
  }
): Pick<AiVaultSessionGroup, 'key' | 'label'> {
  if (group === 'agent') {
    return { key: session.agent, label: agentLabel(session.agent) }
  }
  if (group === 'project') {
    const sessionProject = options.sessionProjectById?.get(session.id)
    if (sessionProject) {
      return {
        key: sessionProject.key,
        label:
          options.projectLabelByKey?.get(sessionProject.key) ||
          sessionProject.label ||
          folderLabel(session.cwd)
      }
    }
  }
  return { key: folderGroupKey(session.cwd), label: folderLabel(session.cwd) }
}
