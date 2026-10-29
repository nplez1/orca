import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { jiraGetIssue } from '@/runtime/runtime-jira-client'
import type { RuntimeJiraSettings } from '@/runtime/runtime-jira-target'
import type { JiraIssue } from '../../../shared/jira/jira-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import {
  mergeJiraIssueHydration,
  type EditableJiraIssueField
} from './jira-issue-workspace-hydration'

/** Re-reads the selected issue (refresh signal or manual retry) and reloads its
 *  transitions. Kept separate from the detail hook to stay within the line cap. */
export function useJiraIssueWorkspaceRefresh({
  displayed,
  providerSettings,
  sourceContext,
  editedFieldsRef,
  reloadTransitions,
  refreshSignal,
  setFullIssue
}: {
  displayed: JiraIssue | null
  providerSettings: RuntimeJiraSettings
  sourceContext?: TaskSourceContext | null
  /** Fields the user has edited, so a read does not overwrite an unsaved edit. */
  editedFieldsRef: React.MutableRefObject<Set<EditableJiraIssueField>>
  reloadTransitions: () => Promise<void>
  refreshSignal: number
  setFullIssue: (issue: JiraIssue | null) => void
}): { refreshIssue: () => Promise<void>; refresh: () => Promise<void>; refreshing: boolean } {
  const patchJiraIssue = useAppStore((s) => s.patchJiraIssue)
  const [refreshing, setRefreshing] = useState(false)
  const lastRefreshSignalRef = useRef(refreshSignal)
  // Why the issue, not the request: a refresh issued for one issue must never land on
  // the next one — `requestKey` would then name the previous issue, and the following
  // edit would be written there while the UI shows this one.
  const issueScope = displayed ? `${displayed.siteId ?? ''}:${displayed.key}` : null
  const scopeRef = useRef(issueScope)
  const readIdRef = useRef(0)

  useEffect(() => {
    scopeRef.current = issueScope
    // Why: a selection move settles every read still in flight for the previous issue.
    readIdRef.current += 1
  }, [issueScope])

  const refreshIssue = useCallback(async (): Promise<void> => {
    if (!displayed) {
      return
    }
    const scope = issueScope
    const readId = ++readIdRef.current
    try {
      const latest = await jiraGetIssue(providerSettings, displayed.key, displayed.siteId)
      if (!latest || readId !== readIdRef.current || scopeRef.current !== scope) {
        return
      }
      const merged = mergeJiraIssueHydration(latest, displayed, new Set(editedFieldsRef.current))
      setFullIssue(merged)
      patchJiraIssue(merged.key, merged, { sourceContext })
    } catch {
      // Keep the visible issue snapshot if refresh fails.
    }
  }, [
    displayed,
    editedFieldsRef,
    issueScope,
    patchJiraIssue,
    providerSettings,
    setFullIssue,
    sourceContext
  ])

  const refresh = useCallback(async (): Promise<void> => {
    if (!displayed) {
      return
    }
    const scope = issueScope
    setRefreshing(true)
    try {
      await refreshIssue()
      // Why the second guard: the transitions read this closure holds is the previous
      // issue's, so reloading it after a selection move lands A's choices in B's picker.
      if (scopeRef.current === scope) {
        await reloadTransitions()
      }
    } finally {
      setRefreshing(false)
    }
  }, [displayed, issueScope, refreshIssue, reloadTransitions])

  useEffect(() => {
    if (lastRefreshSignalRef.current === refreshSignal) {
      return
    }
    lastRefreshSignalRef.current = refreshSignal
    void refresh()
  }, [refresh, refreshSignal])

  return { refreshIssue, refresh, refreshing }
}
