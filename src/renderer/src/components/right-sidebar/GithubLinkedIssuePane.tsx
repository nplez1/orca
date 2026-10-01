import { useCallback, useEffect, useRef, useState } from 'react'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { GHCommentComposer } from '@/components/github-item-dialog/discuss-item/gh-comment-composer'
import { GHEditSection } from '@/components/github-item-dialog/edit-item-fields/gh-edit-section'
import type { PRComment } from '../../../../shared/github/comment-types'
import { IssueCommentThread, type IssueCommentView } from './IssueCommentThread'
import { useGitHubItemDialogDetails } from '@/components/github-item-dialog/load-item-details/use-github-item-dialog-details'
import { lookupGitHubWorkItemForSource } from '@/lib/github-work-item-source-lookup'
import { useAppStore } from '@/store'
import { projectGroupIdFromRepoId } from '../../../../shared/folder-workspace-worktree'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type { Worktree } from '../../../../shared/worktree/types'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import { translate } from '@/i18n/i18n'
import { IssuePaneHeader } from './IssuePaneHeader'
import { IssuePaneMessage } from './IssuePaneMessage'
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

type GithubPaneWorktree = Pick<
  Worktree,
  'id' | 'repoId' | 'linkedWorkItem' | 'linkedTaskSourceContext'
>

/** Folder workspaces borrow a synthetic repo id; their real repo is the one the
 *  linked item was created from. */
function resolveGithubRepoId(worktree: GithubPaneWorktree): string | null {
  if (projectGroupIdFromRepoId(worktree.repoId)) {
    return worktree.linkedWorkItem?.repoId ?? null
  }
  return worktree.repoId
}

/** GitHub issue detail for the pane. Reuses the Task view's work-item fetch,
 *  details hook, and edit controls (`GHEditSection`, `CommentMarkdown`). */
export function GithubLinkedIssuePane({
  worktree,
  linkedIssue,
  sourceContext
}: {
  worktree: GithubPaneWorktree
  linkedIssue: GithubLinked
  sourceContext: TaskSourceContext | null
}): React.JSX.Element {
  const repo = useAppStore((s) => {
    const repoId = resolveGithubRepoId(worktree)
    return repoId ? (s.repos.find((item) => item.id === repoId) ?? null) : null
  })
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
      sourceContext,
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
  }, [linkedIssue.number, repo, sourceContext])

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
        />
        <IssuePaneMessage kind="unavailable" providerLabel="GitHub" />
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
          sourceContext={sourceContext}
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
