import { useCallback, useEffect, useState } from 'react'
import { LinearIssueTextEditor } from '@/components/LinearIssueTextEditor'
import { LinearIssueEditRows } from '@/components/linear-issue-edit-rows'
import { useLinearIssueWorkspaceDetail } from '@/components/linear-issue-workspace-detail-state'
import { useAppStore } from '@/store'
import type { LinearIssue } from '../../../../shared/linear/issue-types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import { IssuePaneHeader } from './IssuePaneHeader'
import { IssuePaneMessage } from './IssuePaneMessage'
import type { SupportedWorkspaceLinkedIssue } from './workspace-linked-issue'

type LinearLinked = Extract<SupportedWorkspaceLinkedIssue, { provider: 'linear' }>

/** Linear issue detail for the pane: compact property rows plus the shared
 *  title/description editor, reusing the Task view's Linear hydration hook. */
export function LinearLinkedIssuePane({
  linkedIssue,
  sourceContext
}: {
  linkedIssue: LinearLinked
  sourceContext: TaskSourceContext | null
}): React.JSX.Element {
  const fetchLinearIssue = useAppStore((s) => s.fetchLinearIssue)
  const entry = useAppStore(
    (s) =>
      s.linearIssueCache[`all::${linkedIssue.identifier}`] ??
      s.linearIssueCache[linkedIssue.identifier]
  )
  const issue = entry?.data ?? null
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    // Why: 'all' — the identifier may belong to a different Linear workspace
    // than the one currently selected.
    void fetchLinearIssue(linkedIssue.identifier, 'all', { sourceContext })
  }, [fetchLinearIssue, linkedIssue.identifier, sourceContext])

  const refresh = useCallback((): void => {
    setRefreshing(true)
    void fetchLinearIssue(linkedIssue.identifier, 'all', { sourceContext, force: true }).finally(
      () => setRefreshing(false)
    )
  }, [fetchLinearIssue, linkedIssue.identifier, sourceContext])

  if (!issue) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <IssuePaneHeader
          provider="linear"
          identifier={linkedIssue.identifier}
          title={linkedIssue.title ?? ''}
          openUrl={linkedIssue.url}
          titleLoading={entry === undefined}
          refreshing={refreshing}
          onRefresh={refresh}
        />
        {entry !== undefined && entry.data === null ? (
          <IssuePaneMessage kind="unavailable" providerLabel="Linear" onRetry={refresh} />
        ) : (
          <IssuePaneMessage kind="loading" />
        )}
      </div>
    )
  }

  return (
    <LinearLinkedIssueDetail
      issue={issue}
      sourceContext={sourceContext}
      refreshing={refreshing}
      onRefresh={refresh}
    />
  )
}

function LinearLinkedIssueDetail({
  issue,
  sourceContext,
  refreshing,
  onRefresh
}: {
  issue: LinearIssue
  sourceContext: TaskSourceContext | null
  refreshing: boolean
  onRefresh: () => void
}): React.JSX.Element {
  const settings = useAppStore((state) => state.settings)
  const providerSettings = sourceContext ?? settings
  const requestKey = `${sourceContext?.hostId ?? settings?.activeRuntimeEnvironmentId ?? 'local'}:${issue.workspaceId ?? 'selected'}:${issue.id}`
  const detail = useLinearIssueWorkspaceDetail({ issue, providerSettings, requestKey })

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <IssuePaneHeader
        provider="linear"
        identifier={detail.displayed.identifier}
        title={detail.displayed.title}
        openUrl={detail.displayed.url ?? null}
        refreshing={refreshing}
        onRefresh={onRefresh}
      />
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">
        <div className="p-2">
          <LinearIssueEditRows
            issue={detail.displayed}
            editState={detail.editState}
            onEditStateChange={detail.handleEditStateChange}
            sourceContext={sourceContext}
          />
        </div>
        <div className="border-t border-border/40 p-3">
          <LinearIssueTextEditor
            issue={detail.displayed}
            onIssueChange={detail.handleIssueTextChange}
            density="drawer"
            sourceContext={sourceContext}
          />
        </div>
      </div>
    </div>
  )
}
