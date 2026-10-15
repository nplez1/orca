import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { jiraGetIssue } from '@/runtime/runtime-jira-client'
import type { RuntimeJiraSettings } from '@/runtime/runtime-jira-target'
import type { JiraIssue } from '../../../shared/jira-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'

/** Re-reads the selected issue (refresh signal or manual retry) and reloads its
 *  transitions. Kept separate from the detail hook to stay within the line cap. */
export function useJiraIssueWorkspaceRefresh({
  displayed,
  providerSettings,
  sourceContext,
  reloadTransitions,
  refreshSignal,
  setFullIssue
}: {
  displayed: JiraIssue | null
  providerSettings: RuntimeJiraSettings
  sourceContext?: TaskSourceContext | null
  reloadTransitions: () => Promise<void>
  refreshSignal: number
  setFullIssue: (issue: JiraIssue | null) => void
}): { refreshIssue: () => Promise<void>; refresh: () => Promise<void>; refreshing: boolean } {
  const patchJiraIssue = useAppStore((s) => s.patchJiraIssue)
  const [refreshing, setRefreshing] = useState(false)
  const lastRefreshSignalRef = useRef(refreshSignal)

  const refreshIssue = useCallback(async (): Promise<void> => {
    if (!displayed) {
      return
    }
    try {
      const latest = await jiraGetIssue(providerSettings, displayed.key, displayed.siteId)
      if (latest) {
        setFullIssue(latest)
        patchJiraIssue(latest.key, latest, { sourceContext })
      }
    } catch {
      // Keep the visible issue snapshot if refresh fails.
    }
  }, [displayed, patchJiraIssue, providerSettings, setFullIssue, sourceContext])

  const refresh = useCallback(async (): Promise<void> => {
    if (!displayed) {
      return
    }
    setRefreshing(true)
    try {
      await refreshIssue()
      await reloadTransitions()
    } finally {
      setRefreshing(false)
    }
  }, [displayed, refreshIssue, reloadTransitions])

  useEffect(() => {
    if (lastRefreshSignalRef.current === refreshSignal) {
      return
    }
    lastRefreshSignalRef.current = refreshSignal
    void refresh()
  }, [refresh, refreshSignal])

  return { refreshIssue, refresh, refreshing }
}
