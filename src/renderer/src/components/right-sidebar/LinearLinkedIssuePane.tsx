import { useCallback, useEffect, useState } from 'react'
import { LinearIssueTextEditor } from '@/components/LinearIssueTextEditor'
import { LinearIssueCommentFooter } from '@/components/LinearItemDrawer'
import { LinearIssueEditRows } from '@/components/linear-issue-edit-rows'
import { useLinearIssueWorkspaceDetail } from '@/components/linear-issue-workspace-detail-state'
import { useAppStore } from '@/store'
import type { LinearComment, LinearIssue } from '../../../../shared/linear/issue-types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type { RuntimeLinearSettings } from '@/runtime/runtime-linear-client'
import { observeLinearIssueRead } from '@/store/slices/linear/linear-issue-read-lifecycle'
import { translate } from '@/i18n/i18n'
import { IssueCommentThread, type IssueCommentView } from './IssueCommentThread'
import { IssuePaneHeader } from './IssuePaneHeader'
import type { IssuePaneIssueSwitcherProps } from './IssuePaneIssueSwitcher'
import { IssuePaneMessage } from './IssuePaneMessage'
import { useLinkedIssuePaneActions } from './use-linked-issue-pane-actions'
import type { SupportedWorkspaceLinkedIssue } from './workspace-linked-issue'

type LinearLinked = Extract<SupportedWorkspaceLinkedIssue, { provider: 'linear' }>

function linearCommentView(comment: LinearComment): IssueCommentView {
  return {
    id: comment.id,
    authorName:
      comment.user?.displayName ??
      translate('auto.components.right.sidebar.IssueComments.unknownAuthor', 'Unknown'),
    authorAvatarUrl: comment.user?.avatarUrl,
    createdAt: comment.createdAt,
    body: comment.body
  }
}

/** Linear issue detail for the pane: compact property rows plus the shared
 *  title/description editor, reusing the Task view's Linear hydration hook. */
export function LinearLinkedIssuePane({
  linkedIssue,
  sourceContext,
  issueSwitcher
}: {
  linkedIssue: LinearLinked
  /** The issue's provider account: the host the workspace's creation-time task came from, else the
   *  workspace's own host. Never the Active Server, so one source drives every read, write and
   *  cache key this pane owns. */
  sourceContext: TaskSourceContext
  issueSwitcher?: IssuePaneIssueSwitcherProps
}): React.JSX.Element {
  const fetchLinearIssue = useAppStore((s) => s.fetchLinearIssue)
  const [issue, setIssue] = useState<LinearIssue | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const linkActions = useLinkedIssuePaneActions(linkedIssue)

  useEffect(() => {
    // Why no workspaceId: the identifier may belong to a different Linear workspace than the one
    // currently selected, and every read here is owner-routed through `sourceContext`.
    return observeLinearIssueRead(
      fetchLinearIssue(linkedIssue.identifier, null, { sourceContext, force: refreshNonce > 0 }),
      () => true,
      (_lease, view) => {
        setIssue(view.data ?? null)
        setLoading(view.kind === 'loading')
        if (view.kind !== 'loading') {
          setRefreshing(false)
        }
      }
    )
  }, [fetchLinearIssue, linkedIssue.identifier, sourceContext, refreshNonce])

  const refresh = useCallback((): void => {
    setRefreshing(true)
    setRefreshNonce((nonce) => nonce + 1)
  }, [])

  if (!issue) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <IssuePaneHeader
          provider="linear"
          identifier={linkedIssue.identifier}
          title={linkedIssue.title ?? ''}
          openUrl={linkedIssue.url}
          titleLoading={loading}
          refreshing={refreshing}
          onRefresh={refresh}
          onOpenIssue={linkActions.openIssue}
          onUnlinkIssue={linkActions.unlinkIssue}
          onLinkAnotherIssue={linkActions.linkAnotherIssue}
          linkActionsDisabledReason={linkActions.linkActionsDisabledReason}
          issueSwitcher={issueSwitcher}
        />
        {loading ? (
          <IssuePaneMessage kind="loading" />
        ) : (
          <IssuePaneMessage kind="unavailable" providerLabel="Linear" onRetry={refresh} />
        )}
      </div>
    )
  }

  return (
    <LinearLinkedIssueDetail
      linkedIssue={linkedIssue}
      issue={issue}
      sourceContext={sourceContext}
      refreshing={refreshing}
      onRefresh={refresh}
      issueSwitcher={issueSwitcher}
    />
  )
}

function LinearLinkedIssueDetail({
  linkedIssue,
  issue,
  sourceContext,
  refreshing,
  onRefresh,
  issueSwitcher
}: {
  linkedIssue: LinearLinked
  issue: LinearIssue
  sourceContext: TaskSourceContext
  refreshing: boolean
  onRefresh: () => void
  issueSwitcher?: IssuePaneIssueSwitcherProps
}): React.JSX.Element {
  // Why the linked identifier and not the fetched one: Linear can return a moved issue under a new
  // identifier, and an action has to address the attachment the workspace actually stored.
  const linkActions = useLinkedIssuePaneActions(linkedIssue)
  const providerSettings: RuntimeLinearSettings = sourceContext
  const requestKey = `${sourceContext.hostId}:${issue.workspaceId ?? 'selected'}:${issue.id}`
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
        onOpenIssue={linkActions.openIssue}
        onUnlinkIssue={linkActions.unlinkIssue}
        onLinkAnotherIssue={linkActions.linkAnotherIssue}
        linkActionsDisabledReason={linkActions.linkActionsDisabledReason}
        issueSwitcher={issueSwitcher}
      />
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">
        <div className="p-2">
          <LinearIssueEditRows
            issue={detail.displayed}
            editState={detail.editState}
            providerSettings={providerSettings}
            sourceContext={sourceContext}
          />
        </div>
        <div className="border-t border-border/40 p-3">
          <LinearIssueTextEditor
            issue={detail.displayed}
            density="drawer"
            sourceContext={sourceContext}
          />
        </div>
        <section className="border-t border-border/40 p-3">
          <IssueCommentThread
            comments={detail.comments.map(linearCommentView)}
            loading={detail.commentsLoading}
            error={detail.commentsError}
            onRetry={() => void detail.retryComments()}
          />
        </section>
      </div>
      <LinearIssueCommentFooter
        issueId={detail.displayed.id}
        workspaceId={detail.displayed.workspaceId}
        onCommentAdded={detail.handleCommentAdded}
        sourceContext={sourceContext}
      />
    </div>
  )
}
