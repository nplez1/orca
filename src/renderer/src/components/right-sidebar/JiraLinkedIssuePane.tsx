import { useCallback, useEffect, useState } from 'react'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { JiraIcon } from '@/components/icons/JiraIcon'
import { useJiraIssueWorkspaceDetail } from '@/components/jira-issue-workspace-detail-state'
import { JiraIssueCommentComposer } from '@/components/jira-issue-workspace-content'
import { jiraSearchUsers } from '@/runtime/runtime-jira-client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { TaskPageJiraPriorityBadge } from '@/components/task-page-jira-priority-badge'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import type { JiraComment, JiraIssue, JiraUser } from '../../../../shared/jira-types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import { translate } from '@/i18n/i18n'
import { IssueAssigneeCombobox, type IssueAssigneeOption } from './IssueAssigneeCombobox'
import { IssueCommentThread, type IssueCommentView } from './IssueCommentThread'
import { IssuePaneHeader } from './IssuePaneHeader'
import { IssuePaneMessage } from './IssuePaneMessage'
import { IssuePanePropertyRow } from './IssuePanePropertyRow'
import type { SupportedWorkspaceLinkedIssue } from './workspace-linked-issue'

type JiraLinked = Extract<SupportedWorkspaceLinkedIssue, { provider: 'jira' }>

function jiraUserOption(user: JiraUser): IssueAssigneeOption {
  return { id: user.accountId, label: user.displayName, avatarUrl: user.avatarUrl }
}

function jiraCommentView(comment: JiraComment): IssueCommentView {
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

function jiraStatusToneClass(categoryKey: string): string {
  if (categoryKey === 'done') {
    return 'bg-emerald-500'
  }
  if (categoryKey === 'indeterminate') {
    return 'bg-sky-500'
  }
  return 'bg-muted-foreground'
}

const MENU_ITEM_CLASS =
  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12px] hover:bg-accent'

/** Jira issue detail for the pane: a compact vertical property list built for
 *  the narrow sidebar, reusing the Task view's Jira hydration hook. */
export function JiraLinkedIssuePane({
  linkedIssue,
  sourceContext
}: {
  linkedIssue: JiraLinked
  sourceContext: TaskSourceContext | null
}): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const viewerAccountId = useAppStore((s) => s.jiraStatus.viewer?.accountId ?? null)
  const providerSettings = sourceContext ?? settings
  const detail = useJiraIssueWorkspaceDetail({
    issue: null,
    // Why: the workspace persists only the issue key; the hook hydrates the rest.
    fetchKey: linkedIssue.key,
    providerSettings,
    sourceContext
  })
  const displayed = detail.displayed
  const siteId = displayed?.siteId ?? undefined

  const searchAssignees = useCallback(
    (query: string): Promise<IssueAssigneeOption[]> =>
      jiraSearchUsers(providerSettings, query, siteId).then((users) => users.map(jiraUserOption)),
    [providerSettings, siteId]
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <IssuePaneHeader
        provider="jira"
        identifier={displayed?.key ?? linkedIssue.key}
        title={displayed?.title ?? linkedIssue.title ?? ''}
        openUrl={displayed?.url ?? linkedIssue.url}
        titleLoading={!displayed && detail.issueLoading}
        titleSaving={detail.pendingField === 'title'}
        refreshing={detail.refreshing}
        onRefresh={() => (displayed ? void detail.refresh() : detail.reload())}
        onTitleCommit={
          displayed ? (title) => void detail.mutateIssue('title', { title }, { title }) : undefined
        }
      />

      {!displayed ? (
        detail.issueLoading ? (
          <IssuePaneMessage kind="loading" />
        ) : (
          <IssuePaneMessage
            kind="unavailable"
            providerLabel="Jira"
            onRetry={() => detail.reload()}
          />
        )
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">
            <div className="space-y-0.5 p-2">
              <JiraStatusRow displayed={displayed} detail={detail} />
              <IssueAssigneeCombobox
                label={translate('auto.components.right.sidebar.IssueAssignee.label', 'Assignee')}
                roster={detail.users.map(jiraUserOption)}
                selected={displayed.assignee ? [jiraUserOption(displayed.assignee)] : []}
                isSelf={viewerAccountId ? (option) => option.id === viewerAccountId : undefined}
                search={searchAssignees}
                pending={detail.pendingField === 'assignee'}
                onSelect={(option) =>
                  void detail.mutateIssue(
                    'assignee',
                    { assigneeAccountId: option.id },
                    {
                      assignee: {
                        accountId: option.id,
                        displayName: option.label,
                        avatarUrl: option.avatarUrl ?? undefined
                      }
                    }
                  )
                }
                onUnassign={() =>
                  void detail.mutateIssue(
                    'assignee',
                    { assigneeAccountId: null },
                    { assignee: undefined }
                  )
                }
              />
              <JiraPriorityRow displayed={displayed} detail={detail} />
              <JiraLabelsRow displayed={displayed} detail={detail} />
            </div>

            <section className="border-t border-border/40 p-3">
              <div className="mb-2 flex items-center gap-2">
                <JiraIcon className="size-3 shrink-0 text-muted-foreground" />
                <span className="text-xs font-medium text-foreground">
                  {displayed.issueType.name}
                </span>
                <span className="min-w-0 truncate text-xs text-muted-foreground">
                  {displayed.project.key}
                </span>
              </div>
              {displayed.description?.trim() ? (
                <CommentMarkdown
                  content={displayed.description}
                  variant="document"
                  className="text-[13px] leading-relaxed"
                />
              ) : (
                <p className="text-xs italic text-muted-foreground">
                  {translate(
                    'auto.components.JiraIssueWorkspace.c4889a47e4',
                    'No description provided.'
                  )}
                </p>
              )}
            </section>

            <section className="border-t border-border/40 p-3">
              <IssueCommentThread
                comments={detail.comments.map(jiraCommentView)}
                loading={detail.commentsLoading}
                error={detail.commentsError}
                onRetry={detail.retryComments}
              />
            </section>
          </div>
          <JiraIssueCommentComposer
            commentDraft={detail.commentDraft}
            setCommentDraft={detail.setCommentDraft}
            commentSubmitting={detail.commentSubmitting}
            canSubmitComment={detail.canSubmitComment}
            handleSubmitComment={() => void detail.handleSubmitComment()}
          />
        </>
      )}
    </div>
  )
}

type JiraDetail = ReturnType<typeof useJiraIssueWorkspaceDetail>

function JiraStatusRow({
  displayed,
  detail
}: {
  displayed: JiraIssue
  detail: JiraDetail
}): React.JSX.Element {
  const pending = detail.pendingField === 'transition'
  return (
    <Popover>
      <PopoverTrigger asChild>
        <IssuePanePropertyRow
          label={translate('auto.components.right.sidebar.IssuePane.status', 'Status')}
          pending={pending}
          disabled={pending || detail.transitions.length === 0}
          value={
            <span className="flex items-center gap-1.5">
              <span
                className={cn(
                  'size-2 shrink-0 rounded-full',
                  jiraStatusToneClass(displayed.status.categoryKey)
                )}
                aria-hidden
              />
              <span className="min-w-0 truncate">{displayed.status.name}</span>
            </span>
          }
        />
      </PopoverTrigger>
      <PopoverContent className="w-52" align="start">
        <div className="max-h-64 overflow-y-auto scrollbar-sleek">
          {detail.transitions.map((transition) => (
            <button
              key={transition.id}
              type="button"
              onClick={() =>
                void detail.mutateIssue(
                  'transition',
                  { transitionId: transition.id },
                  { status: transition.to }
                )
              }
              className={MENU_ITEM_CLASS}
            >
              {transition.name}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function JiraPriorityRow({
  displayed,
  detail
}: {
  displayed: JiraIssue
  detail: JiraDetail
}): React.JSX.Element {
  const pending = detail.pendingField === 'priority'
  return (
    <Popover>
      <PopoverTrigger asChild>
        <IssuePanePropertyRow
          label={translate('auto.components.right.sidebar.IssuePane.priority', 'Priority')}
          pending={pending}
          disabled={pending}
          value={
            displayed.priority?.name ? (
              <TaskPageJiraPriorityBadge priority={displayed.priority} />
            ) : (
              <span className="text-muted-foreground">
                {translate('auto.components.JiraIssueWorkspace.51bed73f88', 'No priority')}
              </span>
            )
          }
        />
      </PopoverTrigger>
      <PopoverContent className="w-48" align="start">
        <button
          type="button"
          onClick={() =>
            void detail.mutateIssue('priority', { priorityId: null }, { priority: undefined })
          }
          className={MENU_ITEM_CLASS}
        >
          {translate('auto.components.JiraIssueWorkspace.51bed73f88', 'No priority')}
        </button>
        {detail.priorities.map((priority) => (
          <button
            key={priority.id}
            type="button"
            onClick={() =>
              void detail.mutateIssue('priority', { priorityId: priority.id }, { priority })
            }
            className={MENU_ITEM_CLASS}
          >
            <TaskPageJiraPriorityBadge priority={priority} />
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}

function JiraLabelsRow({
  displayed,
  detail
}: {
  displayed: JiraIssue
  detail: JiraDetail
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(displayed.labels.join(', '))
  useEffect(() => {
    if (!open) {
      setDraft(displayed.labels.join(', '))
    }
  }, [displayed.labels, open])

  const save = (): void => {
    const labels = draft
      .split(',')
      .map((label) => label.trim())
      .filter(Boolean)
    void detail.mutateIssue('labels', { labels }, { labels })
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <IssuePanePropertyRow
          label={translate('auto.components.right.sidebar.IssuePane.labels', 'Labels')}
          pending={detail.pendingField === 'labels'}
          value={
            displayed.labels.length > 0 ? (
              displayed.labels.join(', ')
            ) : (
              <span className="text-muted-foreground">
                {translate('auto.components.right.sidebar.IssuePane.noLabels', 'None')}
              </span>
            )
          }
        />
      </PopoverTrigger>
      <PopoverContent className="w-64" align="start">
        <div className="p-2">
          <div className="flex gap-2">
            <Input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  save()
                }
              }}
              placeholder={translate(
                'auto.components.JiraIssueWorkspace.0f3c07a901',
                'backend, bug'
              )}
              className="h-8 text-xs"
              autoFocus
            />
            <Button
              size="sm"
              variant="outline"
              onClick={save}
              disabled={detail.pendingField === 'labels'}
            >
              {translate('auto.components.right.sidebar.IssuePane.save', 'Save')}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
