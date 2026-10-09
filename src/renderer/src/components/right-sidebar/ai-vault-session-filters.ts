import { useMemo } from 'react'
import type { AiVaultGroup, AiVaultSession } from '../../../../shared/ai-vault-types'
import {
  filterAiVaultSessions,
  groupAiVaultSessions,
  type AiVaultSessionFilterState
} from '../../../../shared/ai-vault-session-filters'
import { nestAiVaultSubagentSessions } from '../../../../shared/ai-vault-subagent-nesting'
// Why: the pure filter/group/query core now lives in /shared so the mobile
// package can reuse it (Metro can't import renderer). Re-export for renderer
// import parity. Not a byte-for-byte move: tokenizeQuery gained quoted
// repo:/path: operator values (e.g. path:"/a/My Project"), which the old
// renderer tokenizer split on spaces.
export type {
  AiVaultSessionProject,
  AiVaultSessionFilterState,
  AiVaultSessionGroup
} from '../../../../shared/ai-vault-session-filters'
export {
  AI_VAULT_SESSION_FILTER_QUERY_MAX_BYTES,
  agentLabel,
  filterAiVaultSessions,
  folderLabel,
  groupAiVaultSessions,
  isAiVaultSessionFilterQueryTooLarge,
  parseVaultQuery
} from '../../../../shared/ai-vault-session-filters'

/** What the list renders: a null label is a group of rows with no header of its own. */
export type AiVaultSessionListGroup = {
  key: string
  label: string | null
  sessions: AiVaultSession[]
}

// Shared instance so a list with no sub-agent rows keeps referential identity
// across rescans and does not re-render every row.
const NO_SUBAGENT_CHILDREN: ReadonlyMap<string, readonly AiVaultSession[]> = new Map()

export function useAiVaultPanelSessions(
  sessions: readonly AiVaultSession[],
  searching: boolean,
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
    showSubagentSessions
  }: AiVaultSessionFilterState & { showSubagentSessions: boolean }
) {
  const filteredSessions = useMemo(
    () =>
      searching
        ? sessions
        : filterAiVaultSessions(sessions, {
            query,
            agents,
            scope,
            sort,
            activeWorktreePaths,
            activeProjectKey,
            sessionProjectById,
            projectLabelByKey,
            hideEmptySessions
          }),
    [
      searching,
      sessions,
      query,
      agents,
      scope,
      sort,
      activeWorktreePaths,
      activeProjectKey,
      sessionProjectById,
      projectLabelByKey,
      hideEmptySessions
    ]
  )
  // Why: a sub-agent row belongs under its parent, so it is not a top-level
  // row and must not be grouped as one. Search stays flat on purpose — a
  // query is a request for the matching transcripts, sub-agents included.
  const nesting = useMemo(
    () =>
      showSubagentSessions || searching
        ? {
            roots: filteredSessions,
            childrenByParentId: NO_SUBAGENT_CHILDREN,
            hiddenChildCount: 0
          }
        : nestAiVaultSubagentSessions(filteredSessions),
    [filteredSessions, searching, showSubagentSessions]
  )
  const groups = useMemo<AiVaultSessionListGroup[]>(
    () =>
      searching
        ? filteredSessions.length === 0
          ? []
          : // The results bar above the list carries the count, so this group only holds rows.
            [{ key: 'search-results', label: null, sessions: [...filteredSessions] }]
        : groupAiVaultSessions(nesting.roots, group, { sessionProjectById, projectLabelByKey }),
    [searching, filteredSessions, nesting, group, projectLabelByKey, sessionProjectById]
  )
  return {
    filteredSessions,
    groups,
    childrenByParentId: nesting.childrenByParentId,
    hiddenSubagentCount: nesting.hiddenChildCount
  }
}
