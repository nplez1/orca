import type { JiraIssue, JiraProjectStatusOrder } from '../../../../../shared/jira-types'
import type { useTaskPageJiraBoard } from '../../use-task-page-jira-board'
import { TaskPageJiraIssueList } from '@/components/task-page-jira-issue-list'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { LoaderCircle } from 'lucide-react'
import { formatRelativeTime } from '../../task-page-source-context'
import { getJiraStatusTone } from '../../task-page-jira-status-tone'

type TaskPageJiraBoardState = ReturnType<typeof useTaskPageJiraBoard>

type TaskPageJiraBacklogViewProps = {
  board: TaskPageJiraBoardState
  statusOrder: JiraProjectStatusOrder | null
  selectedIssue: JiraIssue | null
  onOpenIssue: (issue: JiraIssue) => void
  onStartWorkspace: (issue: JiraIssue) => void
}

export function TaskPageJiraBacklogView({
  board,
  statusOrder,
  selectedIssue,
  onOpenIssue,
  onStartWorkspace
}: TaskPageJiraBacklogViewProps): React.JSX.Element {
  const backlogTitle =
    board.backlogTotal === null
      ? translate('auto.components.TaskPage.16d73d88ad', 'Backlog')
      : translate('auto.components.TaskPage.jiraBacklogCount', 'Backlog · {{value0}} issues', {
          value0: board.backlogTotal
        })

  return (
    <section aria-label={backlogTitle}>
      {board.overview && board.overview.activeSprints.length === 0 ? (
        <div className="border-b border-border/50 px-3 py-2 text-xs text-muted-foreground">
          {board.overview.board.type === 'scrum'
            ? translate(
                'auto.components.TaskPage.jiraNoActiveSprint',
                'This board has no active sprint; showing its backlog.'
              )
            : translate(
                'auto.components.TaskPage.jiraBoardHasNoSprints',
                'This board does not use sprints; showing its board-filter backlog.'
              )}
        </div>
      ) : null}
      <div className="flex items-center justify-between gap-3 border-b border-border/50 px-3 py-2">
        <h2 className="text-sm font-medium text-foreground">{backlogTitle}</h2>
        <span className="text-xs text-muted-foreground">
          {translate('auto.components.TaskPage.jiraBacklogLoadedCount', '{{value0}} loaded', {
            value0: board.backlogLoadedCount
          })}
        </span>
      </div>
      {board.backlogError ? (
        <div
          role="alert"
          className="border-b border-destructive/20 px-4 py-3 text-sm text-destructive"
        >
          {board.backlogError}
        </div>
      ) : null}
      {board.backlogLoading && board.backlogIssues.length === 0 ? (
        <div className="px-4 py-10 text-center text-sm text-muted-foreground">
          <LoaderCircle className="mx-auto size-4 animate-spin" />
          <span className="mt-2 block">
            {translate('auto.components.TaskPage.jiraBoardLoading', 'Loading…')}
          </span>
        </div>
      ) : null}
      {!board.backlogLoading && board.backlogIssues.length === 0 && !board.backlogError ? (
        <div className="px-4 py-10 text-center text-sm text-muted-foreground">
          {board.backlogIsLast
            ? translate(
                'auto.components.TaskPage.jiraBacklogEmpty',
                'No backlog issues match this filter.'
              )
            : translate(
                'auto.components.TaskPage.jiraBacklogPageEmpty',
                'No matching issues in this page. Load more to continue searching the backlog.'
              )}
        </div>
      ) : null}
      {board.backlogIssues.length > 0 ? (
        <TaskPageJiraIssueList
          formatUpdatedAt={formatRelativeTime}
          getStatusTone={getJiraStatusTone}
          issues={board.backlogIssues}
          onOpenIssue={onOpenIssue}
          onStartWorkspace={onStartWorkspace}
          selectedIssue={selectedIssue}
          showSiteContext={false}
          statusOrder={statusOrder}
          groupByStatus={false}
        />
      ) : null}
      {!board.backlogIsLast ? (
        <div className="flex justify-center border-t border-border/50 p-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={board.backlogLoadingMore}
            onClick={() => void board.loadMoreBacklog()}
          >
            {board.backlogLoadingMore
              ? translate('auto.components.TaskPage.jiraBoardLoadingMore', 'Loading…')
              : translate(
                  'auto.components.TaskPage.jiraLoadMoreBacklog',
                  'Load more backlog issues'
                )}
          </Button>
        </div>
      ) : null}
    </section>
  )
}
