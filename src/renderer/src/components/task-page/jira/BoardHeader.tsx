import type { TaskPageJiraBoardFilter } from '../../task-page-jira-board-model'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { LoaderCircle, RefreshCw } from 'lucide-react'

type TaskPageJiraBoardHeaderProps = {
  boardName?: string
  activeView: 'sprint' | 'backlog'
  sprintAvailable: boolean | null
  onViewChange: (view: 'sprint' | 'backlog') => void
  filter: TaskPageJiraBoardFilter
  onFilterChange: (filter: TaskPageJiraBoardFilter) => void
  viewerAvailable: boolean
  teamFilterReady: boolean
  loading: boolean
  onRefresh: () => void
  onUseIssueList: () => void
  onConfigureTeam: () => void
}

export function TaskPageJiraBoardHeader({
  boardName,
  activeView,
  sprintAvailable,
  onViewChange,
  filter,
  onFilterChange,
  viewerAvailable,
  teamFilterReady,
  loading,
  onRefresh,
  onUseIssueList,
  onConfigureTeam
}: TaskPageJiraBoardHeaderProps): React.JSX.Element {
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/50 bg-muted/35 px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            {boardName ?? translate('auto.components.TaskPage.jiraBoardView', 'Jira board')}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {sprintAvailable === true
              ? translate(
                  'auto.components.TaskPage.jiraBoardStatusColumns',
                  'Status columns · active sprint only'
                )
              : sprintAvailable === false
                ? translate(
                    'auto.components.TaskPage.jiraBoardNoSprintDescription',
                    'No active sprint · board-filter backlog'
                  )
                : translate(
                    'auto.components.TaskPage.jiraBoardSprintLoading',
                    'Loading sprint details from the board'
                  )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" size="xs" onClick={onUseIssueList}>
            {translate('auto.components.TaskPage.jiraIssueListView', 'Issue list')}
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                onClick={onRefresh}
                disabled={loading}
                aria-label={translate('auto.components.TaskPage.2ff9fd71fd', 'Refresh Jira issues')}
              >
                {loading ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {translate('auto.components.TaskPage.2ff9fd71fd', 'Refresh Jira issues')}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/50 px-3 py-2">
        <div
          className="flex items-center gap-1"
          role="group"
          aria-label={translate('auto.components.TaskPage.jiraBoardViews', 'Jira board views')}
        >
          <Button
            type="button"
            aria-pressed={activeView === 'sprint'}
            variant={activeView === 'sprint' ? 'secondary' : 'ghost'}
            size="sm"
            disabled={sprintAvailable !== true}
            onClick={() => onViewChange('sprint')}
          >
            {translate('auto.components.TaskPage.jiraSprintView', 'Sprint')}
          </Button>
          <Button
            type="button"
            aria-pressed={activeView === 'backlog'}
            variant={activeView === 'backlog' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => onViewChange('backlog')}
          >
            {translate('auto.components.TaskPage.16d73d88ad', 'Backlog')}
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {translate('auto.components.TaskPage.jiraFilterLabel', 'Filter')}
          </span>
          <div
            className="flex items-center gap-1"
            role="group"
            aria-label={translate(
              'auto.components.TaskPage.jiraFilterGroupLabel',
              'Filter Jira issues'
            )}
          >
            <Button
              type="button"
              variant={filter === 'me' ? 'secondary' : 'ghost'}
              size="xs"
              aria-pressed={filter === 'me'}
              onClick={() => onFilterChange('me')}
              disabled={!viewerAvailable}
            >
              {translate('auto.components.TaskPage.jiraMeFilter', 'Me')}
            </Button>
            <Button
              type="button"
              variant={filter === 'team' ? 'secondary' : 'ghost'}
              size="xs"
              aria-pressed={filter === 'team'}
              onClick={() => onFilterChange('team')}
              disabled={!teamFilterReady}
            >
              {translate('auto.components.TaskPage.jiraTeamFilter', 'Team')}
            </Button>
            <Button
              type="button"
              variant={filter === 'all' ? 'secondary' : 'ghost'}
              size="xs"
              aria-pressed={filter === 'all'}
              onClick={() => onFilterChange('all')}
            >
              {translate('auto.components.TaskPage.jiraAllFilter', 'All')}
            </Button>
          </div>
          {!teamFilterReady ? (
            <Button type="button" variant="link" size="xs" onClick={onConfigureTeam}>
              {translate('auto.components.TaskPage.jiraConfigureTeamFilter', 'Configure Team')}
            </Button>
          ) : null}
        </div>
      </div>
    </>
  )
}
