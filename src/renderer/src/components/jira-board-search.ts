import { useEffect, useMemo, useState } from 'react'
import type { JiraBoard, JiraSiteSelection } from '../../../shared/jira/jira-types'
import type { GlobalSettings } from '../../../shared/settings/global-settings-types'
import { runtimeHostIdFromEnvironmentId } from '../../../shared/work-items/task-source-context'
import { taskSourceRuntimeTarget } from '@/lib/work-items/task-source-runtime-target'
import { jiraListBoards, type RuntimeJiraSettings } from '@/runtime/jira/runtime-jira-client'
import { extractIpcErrorMessage } from '@/runtime/errors/ipc-error'
import { translate } from '@/i18n/i18n'

// Why: the picker queries Jira by name, so every keystroke must not become a request.
const BOARD_SEARCH_DEBOUNCE_MS = 300

/** The runtime that serves this settings pane's Jira account. Keyed by the host id rather than
 *  the settings object, so an unrelated settings write does not re-list the boards. */
export function useJiraBoardRuntimeSettings(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
): RuntimeJiraSettings {
  const scopeEnvironmentId = settings?.activeRuntimeEnvironmentId
  return useMemo(
    () => taskSourceRuntimeTarget({ hostId: runtimeHostIdFromEnvironmentId(scopeEnvironmentId) }),
    [scopeEnvironmentId]
  )
}

export type JiraBoardSearch = {
  boards: JiraBoard[]
  loading: boolean
  error: string | null
  query: string
  setQuery: (query: string) => void
  retry: () => void
}

/** One searchable board list, shared by the settings pane and the Tasks switcher.
 *
 *  `jira.listBoards` is one page per site plus Jira's own name filter (full paging took ~74 s on
 *  large sites), so this debounces the query and never pages. */
export function useJiraBoardSearch(input: {
  runtimeSettings: RuntimeJiraSettings
  siteId: JiraSiteSelection | null | undefined
  /** False keeps the list untouched: the switcher only asks Jira when it opens. */
  enabled?: boolean
}): JiraBoardSearch {
  const { runtimeSettings, siteId, enabled = true } = input
  const [query, setQuery] = useState('')
  const [appliedQuery, setAppliedQuery] = useState('')
  const [boards, setBoards] = useState<JiraBoard[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retryNonce, setRetryNonce] = useState(0)

  useEffect(() => {
    const timer = setTimeout(() => setAppliedQuery(query.trim()), BOARD_SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query])

  useEffect(() => {
    if (!enabled) {
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    void jiraListBoards(runtimeSettings, siteId, appliedQuery || undefined)
      .then((nextBoards) => {
        if (!cancelled) {
          setBoards(nextBoards)
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(
            extractIpcErrorMessage(
              cause,
              translate('jira.settings.boardLoadFailed', 'Jira settings could not be loaded.')
            )
          )
          setBoards([])
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [appliedQuery, enabled, retryNonce, runtimeSettings, siteId])

  return {
    boards,
    loading,
    error,
    query,
    setQuery,
    retry: () => setRetryNonce((nonce) => nonce + 1)
  }
}
