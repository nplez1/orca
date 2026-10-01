import { useEffect, useMemo, useState } from 'react'
import { CircleDashed, CircleDot } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { getStateLabel } from '@/components/github/work-item-state-presentation'
import { translate } from '@/i18n/i18n'
import {
  IssueAssigneeCombobox,
  type IssueAssigneeOption
} from '@/components/right-sidebar/IssueAssigneeCombobox'
import { IssuePanePropertyRow } from '@/components/right-sidebar/IssuePanePropertyRow'
import type { GHEditSectionPillsProps } from './gh-edit-section-pills'

const checkIcon = (
  <svg className="size-2.5" viewBox="0 0 12 12" fill="none">
    <path
      d="M2 6l3 3l5-5"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

const MENU_ITEM_CLASS =
  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12px] hover:bg-accent'

/** GitHub issue fields as compact rows for the narrow Issue pane. Shares the
 *  same mutation handlers and rosters as the Task view's `GHEditSection`, so
 *  cache invalidation stays identical. */
export function GHEditSectionRows(props: GHEditSectionPillsProps): React.JSX.Element {
  const {
    item,
    localState,
    localLabels,
    localAssignees,
    repoLabels,
    repoAssignees,
    isStatePending,
    isAssigneesPending,
    isLabelsPending,
    statusPopoverOpen,
    labelPopoverOpen,
    onStatusOpenChange,
    onLabelOpenChange,
    onStateChange,
    onAssigneeToggle,
    onLabelToggle
  } = props

  const [viewerLogin, setViewerLogin] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void Promise.resolve(window.api?.gh?.viewer?.())
      .then((viewer) => {
        if (!cancelled) {
          setViewerLogin(viewer?.login ?? null)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const assigneeRoster: IssueAssigneeOption[] = repoAssignees.data.map((user) => ({
    id: user.login,
    label: user.name ?? user.login,
    avatarUrl: user.avatarUrl
  }))
  const [labelQuery, setLabelQuery] = useState('')
  const handleLabelOpenChange = (open: boolean): void => {
    // Reset the filter on close so the next open starts from the full list.
    if (!open) {
      setLabelQuery('')
    }
    onLabelOpenChange(open)
  }
  const filteredLabels = useMemo(() => {
    const needle = labelQuery.trim().toLowerCase()
    return needle
      ? repoLabels.data.filter((label) => label.toLowerCase().includes(needle))
      : repoLabels.data
  }, [labelQuery, repoLabels.data])

  const selectedAssignees: IssueAssigneeOption[] = localAssignees.map((login) => ({
    id: login,
    label: login
  }))

  return (
    <div className="space-y-0.5">
      <Popover open={statusPopoverOpen} onOpenChange={onStatusOpenChange}>
        <PopoverTrigger asChild>
          <IssuePanePropertyRow
            label={translate('auto.components.right.sidebar.IssuePane.status', 'Status')}
            pending={isStatePending}
            disabled={isStatePending}
            value={
              <span
                className={cn(
                  'flex items-center gap-1.5',
                  localState === 'closed' && 'text-muted-foreground'
                )}
              >
                {localState === 'closed' ? (
                  <CircleDashed className="size-3.5 shrink-0" />
                ) : (
                  <CircleDot className="size-3.5 shrink-0" />
                )}
                <span className="min-w-0 truncate">
                  {getStateLabel({ ...item, state: localState })}
                </span>
              </span>
            }
          />
        </PopoverTrigger>
        <PopoverContent className="w-40" align="start">
          {(['open', 'closed'] as const).map((state) => (
            <button
              key={state}
              type="button"
              onClick={() => {
                onStateChange(state)
                onStatusOpenChange(false)
              }}
              className={cn(MENU_ITEM_CLASS, localState === state && 'bg-accent/50')}
            >
              {state === 'open' ? (
                <CircleDot className="size-3.5" />
              ) : (
                <CircleDashed className="size-3.5" />
              )}
              {getStateLabel({ ...item, state })}
            </button>
          ))}
        </PopoverContent>
      </Popover>

      <IssueAssigneeCombobox
        label={translate('auto.components.right.sidebar.IssueAssignee.assignees', 'Assignees')}
        multiple
        roster={assigneeRoster}
        selected={selectedAssignees}
        isSelf={viewerLogin ? (option) => option.id === viewerLogin : undefined}
        pending={isAssigneesPending}
        disabled={repoAssignees.loading}
        onSelect={(option) => onAssigneeToggle(option.id)}
      />

      <Popover open={labelPopoverOpen} onOpenChange={handleLabelOpenChange}>
        <PopoverTrigger asChild>
          <IssuePanePropertyRow
            label={translate('auto.components.right.sidebar.IssuePane.labels', 'Labels')}
            pending={isLabelsPending}
            disabled={isLabelsPending}
            value={
              localLabels.length ? (
                localLabels.join(', ')
              ) : (
                <span className="text-muted-foreground">
                  {translate('auto.components.right.sidebar.IssuePane.noLabels', 'None')}
                </span>
              )
            }
          />
        </PopoverTrigger>
        <PopoverContent className="w-60" align="start">
          <div className="p-1">
            <Input
              value={labelQuery}
              onChange={(event) => setLabelQuery(event.target.value)}
              placeholder={translate(
                'auto.components.right.sidebar.IssuePane.filterLabels',
                'Filter labels'
              )}
              className="mb-1 h-7"
              autoFocus
            />
            <div className="max-h-64 overflow-y-auto scrollbar-sleek">
              {repoLabels.error ? (
                <div className="px-2 py-3 text-center text-[12px] text-destructive">
                  {repoLabels.error}
                </div>
              ) : filteredLabels.length === 0 ? (
                <p className="px-2 py-1.5 text-[12px] text-muted-foreground">
                  {translate(
                    'auto.components.right.sidebar.IssuePane.noLabelsFound',
                    'No labels found'
                  )}
                </p>
              ) : (
                filteredLabels.map((label) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => onLabelToggle(label)}
                    className={MENU_ITEM_CLASS}
                  >
                    <span
                      className={cn(
                        'flex size-3.5 items-center justify-center rounded-sm border',
                        localLabels.includes(label)
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-input'
                      )}
                    >
                      {localLabels.includes(label) && checkIcon}
                    </span>
                    <span className="min-w-0 truncate">{label}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
