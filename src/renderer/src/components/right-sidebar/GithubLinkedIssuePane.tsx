import { useCallback, useEffect, useRef, useState } from 'react'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { GHCommentComposer } from '@/components/github-item-dialog/discuss-item/gh-comment-composer'
import { GHEditSection } from '@/components/github-item-dialog/edit-item-fields/gh-edit-section'
import type { PRComment } from '../../../../shared/github/comment-types'
import { IssueCommentThread, type IssueCommentView } from './IssueCommentThread'
import { useGitHubItemDialogDetails } from '@/components/github-item-dialog/load-item-details/use-github-item-dialog-details'
import { lookupGitHubWorkItemForSource } from '@/lib/github-work-item-source-lookup'
import { getGitHubRepoRoutingTarget } from '@/lib/github-source-runtime-context'
import { findLinkedIssueRepo, linkedIssueRepoIsOffDevice } from '@/lib/linked-issue-repo'
import { useAppStore } from '@/store'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type { Worktree } from '../../../../shared/worktree/types'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import { translate } from '@/i18n/i18n'
import { IssuePaneHeader } from './IssuePaneHeader'
import type { IssuePaneIssueSwitcherProps } from './IssuePaneIssueSwitcher'
import { IssuePaneMessage } from './IssuePaneMessage'
import { useLinkedIssuePaneActions } from './use-linked-issue-pane-actions'
import type { SupportedWorkspaceLinkedIssue } from './workspace-linked-issue'

type GithubLinked = Extract<SupportedWorkspaceLinkedIssue, { provider: 'github' }>

function githubCommentView(comment: PRComment): IssueCommentView {
  return {
    id: String(comment.id),
    authorName: comment.author,
    authorAvatarUrl: comment.authorAvatarUrl,
    createdAt: comment.createdAt,
    body: comment.body
  }
}

type GithubPaneWorktree = Pick<Worktree, 'repoId' | 'linkedWorkItem'>

/**
 * Task-source context to pass alongside this repo row, or null.
 *
 * The row names the repo path, the repo id and the transport for this read. A source context
 * that names a different repo is the workspace's creation record, not this link's repo, and
 * forwarding it is what asked another host for a repo id only this device has. One that names
 * the same repo is consistent, and is kept so the read keeps its source-scoped cache identity.
 * (It selects no account: downstream it only scopes the cache and the host guard.)
 */
function readSourceContext(
  sourceContext: TaskSourceContext | null,
  repoId: string
): TaskSourceContext | null {
  return sourceContext?.provider === 'github' && sourceContext.repoId === repoId
    ? sourceContext
    : null
}

/** GitHub issue detail for the pane. Reuses the Task view's work-item fetch,
 *  details hook, and edit controls (`GHEditSection`, `CommentMarkdown`). */
export function GithubLinkedIssuePane({
  worktree,
  linkedIssue,
  sourceContext,
  issueSwitcher
}: {
  worktree: GithubPaneWorktree
  linkedIssue: GithubLinked
  sourceContext: TaskSourceContext | null
  issueSwitcher?: IssuePaneIssueSwitcherProps
}): React.JSX.Element {
  const repo = useAppStore((s) => findLinkedIssueRepo(s.repos, worktree, linkedIssue.number))
  // Why a distinct state: the link names a repo this device does not have, which is a setup
  // problem, not a failed request — retrying the same read cannot fix it.
  const repoIsOffDevice = useAppStore((s) =>
    linkedIssueRepoIsOffDevice(s.repos, worktree, linkedIssue.number)
  )
  const scopedSourceContext = repo ? readSourceContext(sourceContext, repo.id) : null
  const linkActions = useLinkedIssuePaneActions(linkedIssue)
  const [workItem, setWorkItem] = useState<GitHubWorkItem | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const generationRef = useRef(0)

  const load = useCallback((): void => {
    if (!repo) {
      return
    }
    const generation = ++generationRef.current
    setLoading(true)
    setFailed(false)
    void lookupGitHubWorkItemForSource({
      repoPath: repo.path,
      repoId: repo.id,
      // Why the repo's owner: the link this pane renders can carry no task-source context, and
      // the source-context fallback would read a runtime-owned repo on this app's IPC instead.
      target: getGitHubRepoRoutingTarget(useAppStore.getState(), repo.id, scopedSourceContext),
      sourceContext: scopedSourceContext,
      number: linkedIssue.number,
      type: 'issue'
    })
      .then((item) => {
        // Why: a slower earlier lookup must not overwrite the item the user is
        // now looking at after a refresh or workspace switch.
        if (generation !== generationRef.current) {
          return
        }
        setWorkItem(item)
        setFailed(item === null)
      })
      .catch(() => {
        if (generation === generationRef.current) {
          setFailed(true)
        }
      })
      .finally(() => {
        if (generation === generationRef.current) {
          setLoading(false)
        }
      })
  }, [linkedIssue.number, repo, scopedSourceContext])

  useEffect(() => {
    load()
  }, [load])

  if (!repo) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <IssuePaneHeader
          provider="github"
          identifier={linkedIssue.identifier}
          title={linkedIssue.title ?? ''}
          openUrl={linkedIssue.url}
          onRefresh={() => {}}
          onOpenIssue={linkActions.openIssue}
          onUnlinkIssue={linkActions.unlinkIssue}
          onLinkAnotherIssue={linkActions.linkAnotherIssue}
          linkActionsDisabledReason={linkActions.linkActionsDisabledReason}
          issueSwitcher={issueSwitcher}
        />
        <IssuePaneMessage
          kind={repoIsOffDevice ? 'repoOffDevice' : 'unavailable'}
          providerLabel="GitHub"
        />
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <IssuePaneHeader
        provider="github"
        identifier={workItem ? `#${workItem.number}` : linkedIssue.identifier}
        title={workItem?.title ?? linkedIssue.title ?? ''}
        openUrl={workItem?.url ?? linkedIssue.url}
        titleLoading={loading && !workItem}
        refreshing={loading}
        onRefresh={load}
        onOpenIssue={linkActions.openIssue}
        onUnlinkIssue={linkActions.unlinkIssue}
        onLinkAnotherIssue={linkActions.linkAnotherIssue}
        linkActionsDisabledReason={linkActions.linkActionsDisabledReason}
        issueSwitcher={issueSwitcher}
      />
      {!workItem ? (
        loading ? (
          <IssuePaneMessage kind="loading" />
        ) : (
          <IssuePaneMessage
            kind="unavailable"
            providerLabel="GitHub"
            onRetry={failed ? load : undefined}
          />
        )
      ) : (
        <GithubLinkedIssueDetail
          workItem={workItem}
          repoPath={repo.path}
          repoId={repo.id}
          sourceContext={scopedSourceContext}
        />
      )}
    </div>
  )
}

function GithubLinkedIssueDetail({
  workItem,
  repoPath,
  repoId,
  sourceContext
}: {
  workItem: GitHubWorkItem
  repoPath: string
  repoId: string
  sourceContext: TaskSourceContext | null
}): React.JSX.Element {
  const {
    details,
    displayWorkItem,
    invalidateCurrentDetailsCache,
    appendOptimisticComment,
    loading,
    error
  } = useGitHubItemDialogDetails({
    workItem,
    repoPath,
    effectiveRepoId: repoId,
    sourceContext
  })
  const resolved = displayWorkItem ?? workItem
  const [localState, setLocalState] = useState<GitHubWorkItem['state']>(resolved.state)
  const [localLabels, setLocalLabels] = useState<string[]>(resolved.labels)
  const resolvedState = details?.item.state ?? workItem.state
  const workItemLabels = workItem.labels
  const workItemId = workItem.id

  // Why: the opening row can be stale; the detail payload has authoritative
  // state, so refresh the local edit UI from it. Mirror `GitHubItemDialog`.
  useEffect(() => {
    if (resolvedState) {
      setLocalState(resolvedState)
    }
    if (workItemLabels) {
      setLocalLabels(workItemLabels)
    }
  }, [workItemId, resolvedState, workItemLabels])

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">
        <div className="p-2">
          <GHEditSection
            item={resolved}
            repoPath={repoPath}
            repoId={repoId}
            sourceContext={sourceContext}
            projectOrigin={undefined}
            localState={localState}
            localLabels={localLabels}
            onStateChange={setLocalState}
            onLabelsChange={setLocalLabels}
            onMutated={invalidateCurrentDetailsCache}
            assignees={details?.assignees ?? []}
            onUse={() => {}}
            layout="rows"
          />
        </div>
        <div className="border-t border-border/40 p-3">
          {details?.body?.trim() ? (
            <CommentMarkdown
              content={details.body}
              variant="document"
              className="text-[13px] leading-relaxed"
            />
          ) : (
            <p className="text-xs italic text-muted-foreground">
              {translate(
                'auto.components.right.sidebar.IssuePane.noDescription',
                'No description provided.'
              )}
            </p>
          )}
        </div>
        <section className="border-t border-border/40 p-3">
          <IssueCommentThread
            comments={(details?.comments ?? []).map(githubCommentView)}
            loading={loading}
            error={error}
            onRetry={invalidateCurrentDetailsCache}
          />
        </section>
      </div>
      <div className="flex-none border-t border-border/60 bg-background px-3 py-3">
        <GHCommentComposer
          repoPath={repoPath}
          repoId={repoId}
          sourceContext={sourceContext}
          issueNumber={workItem.number}
          itemType="issue"
          onCommentAdded={appendOptimisticComment}
        />
      </div>
    </div>
  )
}
