import { useMemo } from 'react'
import type {
  AiVaultGroup,
  AiVaultSession
} from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import {
  filterAiVaultSessions,
  groupAiVaultSessions,
  type AiVaultSessionFilterState
} from '../../../../../../shared/ai-vault/session-display/ai-vault-session-filters'
import { nestAiVaultSubagentSessions } from '../../../../../../shared/ai-vault-subagent-nesting'
// Why: the pure filter/group/query core now lives in /shared so the mobile
// package can reuse it (Metro can't import renderer). Re-export for renderer
// import parity. Not a byte-for-byte move: tokenizeQuery gained quoted
// repo:/path: operator values (e.g. path:"/a/My Project"), which the old
// renderer tokenizer split on spaces.
export type {
  AiVaultSessionProject,
  AiVaultSessionFilterState,
  AiVaultSessionGroup
} from '../../../../../../shared/ai-vault/session-display/ai-vault-session-filters'
export {
  AI_VAULT_SESSION_FILTER_QUERY_MAX_BYTES,
  agentLabel,
  filterAiVaultSessions,
  folderLabel,
  groupAiVaultSessions,
  isAiVaultSessionFilterQueryTooLarge,
  parseVaultQuery
} from '../../../../../../shared/ai-vault/session-display/ai-vault-session-filters'

/** What the list renders: a null label is a group of rows with no header of its own. */
export type AiVaultSessionListGroup = {
  key: string
  label: string | null
  sessions: AiVaultSession[]
}

// Shared instance so a list with no sub-agent rows keeps referential identity
// across rescans and does not re-render every row.
const NO_SUBAGENT_CHILDREN: ReadonlyMap<string, readonly AiVaultSession[]> = new Map()

/** Rows that list as one, as a group room's members: placed before filters run, folded after. */
export type AiVaultRoomRows = {
  place: (rows: readonly AiVaultSession[]) => readonly AiVaultSession[]
  fold: (rows: readonly AiVaultSession[]) => readonly AiVaultSession[]
}

const keepRows = (rows: readonly AiVaultSession[]): readonly AiVaultSession[] => rows
const KEEP_ROWS: AiVaultRoomRows = { place: keepRows, fold: keepRows }

/** Browse groups title-filtered sessions; search lists hits as given, or title matches until hits arrive. */
export type AiVaultPanelListMode = 'browse' | 'search-hits' | 'search-titles'

export function useAiVaultPanelSessions(
  sessions: readonly AiVaultSession[],
  mode: AiVaultPanelListMode,
  group: AiVaultGroup,
  {
    query,
    agents,
    scope,
    sort,
    activeWorktreePaths,
    activeProjectKey,
    sessionProjectById,
    projectLabelByKey,
    hideEmptySessions,
    showSubagentSessions,
    roomRows = KEEP_ROWS
  }: AiVaultSessionFilterState & { showSubagentSessions: boolean; roomRows?: AiVaultRoomRows }
) {
  const filteredSessions = useMemo(() => {
    const placed = roomRows.place(sessions)
    return roomRows.fold(
      mode === 'search-hits'
        ? placed
        : filterAiVaultSessions(placed, {
            query,
            agents,
            scope,
            sort,
            activeWorktreePaths,
            activeProjectKey,
            sessionProjectById,
            projectLabelByKey,
            hideEmptySessions
          })
    )
  }, [
    mode,
    sessions,
    query,
    agents,
    scope,
    sort,
    activeWorktreePaths,
    activeProjectKey,
    sessionProjectById,
    projectLabelByKey,
    hideEmptySessions,
    roomRows
  ])
  // Why: a sub-agent row belongs under its parent, so it is not a top-level
  // row and must not be grouped as one. Search stays flat on purpose — a
  // query is a request for the matching transcripts, sub-agents included.
  const nesting = useMemo(
    () =>
      showSubagentSessions || mode !== 'browse'
        ? {
            roots: filteredSessions,
            childrenByParentId: NO_SUBAGENT_CHILDREN,
            hiddenChildCount: 0
          }
        : nestAiVaultSubagentSessions(filteredSessions),
    [filteredSessions, mode, showSubagentSessions]
  )
  const groups = useMemo<AiVaultSessionListGroup[]>(
    () =>
      mode !== 'browse'
        ? nesting.roots.length === 0
          ? []
          : // The results bar above the list carries the count, so this group only holds rows.
            [{ key: 'search-results', label: null, sessions: [...nesting.roots] }]
        : groupAiVaultSessions(nesting.roots, group, {
            sessionProjectById,
            projectLabelByKey
          }),
    [mode, nesting, group, projectLabelByKey, sessionProjectById]
  )
  return {
    filteredSessions,
    groups,
    childrenByParentId: nesting.childrenByParentId,
    hiddenSubagentCount: nesting.hiddenChildCount
  }
}
