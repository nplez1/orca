import React from 'react'
import { LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { getLinearStateMarkerStyle } from '@/components/linear-state-pill-style'
import { LinearPriorityIcon } from '@/components/linear-priority-icon'
import { useAppStore } from '@/store'
import {
  useLinearIssueEditController,
  type LinearIssueEditController
} from '@/components/linear-item-drawer-edit-controller'
import type { LinearIssueEditSectionProps } from '@/components/linear-item-drawer-types'
import {
  LINEAR_EDIT_MENU_ITEM_WITH_ICON_CLASS,
  LINEAR_ESTIMATE_PRESETS,
  PRIORITY_LABELS,
  formatLinearEstimateLabel
} from '@/components/linear-item-drawer-edit-controls'
import { translate } from '@/i18n/i18n'
import {
  IssueAssigneeCombobox,
  type IssueAssigneeOption
} from './right-sidebar/IssueAssigneeCombobox'
import { IssuePanePropertyRow } from './right-sidebar/IssuePanePropertyRow'

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

/** Linear property editing as compact rows for the narrow Issue pane.
 *  Reuses the same `useLinearIssueEditController` the Task view's properties
 *  layout drives, so mutations and cache invalidation stay identical. */
export function LinearIssueEditRows(props: LinearIssueEditSectionProps): React.JSX.Element {
  const controller = useLinearIssueEditController({ ...props, layout: 'properties' })
  return (
    <div className="space-y-0.5">
      <LinearStatusRow controller={controller} />
      <LinearAssigneeRow controller={controller} />
      <LinearPriorityRow controller={controller} />
      <LinearEstimateRow controller={controller} />
      <LinearLabelsRow controller={controller} />
    </div>
  )
}

function LinearStatusRow({
  controller
}: {
  controller: LinearIssueEditController
}): React.JSX.Element {
  const { states, localState, currentStateId, handleStateChange, statePending } = controller
  return (
    <Popover>
      <PopoverTrigger asChild>
        <IssuePanePropertyRow
          label={translate('auto.components.right.sidebar.IssuePane.status', 'Status')}
          pending={statePending}
          disabled={statePending}
          value={
            <span className="flex items-center gap-1.5">
              <span
                className="size-2 shrink-0 rounded-full"
                style={getLinearStateMarkerStyle(localState.color)}
                aria-hidden
              />
              <span className="min-w-0 truncate">{localState.name}</span>
            </span>
          }
        />
      </PopoverTrigger>
      <PopoverContent className="w-48" align="start">
        {states.error ? (
          <div className="px-2 py-3 text-center text-[12px] text-destructive">{states.error}</div>
        ) : states.loading ? (
          <div className="flex items-center gap-2 px-2 py-3 text-[12px] text-muted-foreground">
            <LoaderCircle className="size-3 animate-spin" />
            {translate('auto.components.LinearItemDrawer.59b6cd3706', 'Loading states')}
          </div>
        ) : (
          states.data.map((state) => (
            <button
              key={state.id}
              type="button"
              onClick={() => handleStateChange(state.id)}
              className={cn(
                LINEAR_EDIT_MENU_ITEM_WITH_ICON_CLASS,
                currentStateId === state.id && 'bg-accent/50'
              )}
            >
              <span
                className="inline-block size-2 rounded-full"
                style={{ backgroundColor: state.color }}
              />
              {state.name}
            </button>
          ))
        )}
      </PopoverContent>
    </Popover>
  )
}

function LinearAssigneeRow({
  controller
}: {
  controller: LinearIssueEditController
}): React.JSX.Element {
  const { members, localAssignee, handleAssigneeChange, assigneePending } = controller
  const viewerEmail = useAppStore((state) => state.linearStatus.viewer?.email ?? null)
  const roster: IssueAssigneeOption[] = members.data.map((member) => ({
    id: member.id,
    label: member.displayName,
    avatarUrl: member.avatarUrl,
    email: member.email ?? null
  }))
  return (
    <IssueAssigneeCombobox
      label={translate('auto.components.right.sidebar.IssueAssignee.label', 'Assignee')}
      roster={roster}
      selected={
        localAssignee
          ? [
              {
                id: localAssignee.id,
                label: localAssignee.displayName,
                avatarUrl: localAssignee.avatarUrl
              }
            ]
          : []
      }
      isSelf={
        viewerEmail ? (option) => Boolean(option.email && option.email === viewerEmail) : undefined
      }
      pending={assigneePending}
      onSelect={(option) => handleAssigneeChange(option.id)}
      onUnassign={() => handleAssigneeChange('__unassign__')}
    />
  )
}

function LinearPriorityRow({
  controller
}: {
  controller: LinearIssueEditController
}): React.JSX.Element {
  const { localPriority, handlePriorityChange, priorityPending } = controller
  return (
    <Popover>
      <PopoverTrigger asChild>
        <IssuePanePropertyRow
          label={translate('auto.components.right.sidebar.IssuePane.priority', 'Priority')}
          pending={priorityPending}
          disabled={priorityPending}
          value={
            <span className="flex items-center gap-1.5">
              <LinearPriorityIcon priority={localPriority} />
              <span className="min-w-0 truncate">
                {PRIORITY_LABELS[localPriority] ?? `P${localPriority}`}
              </span>
            </span>
          }
        />
      </PopoverTrigger>
      <PopoverContent className="w-36" align="start">
        {[0, 1, 2, 3, 4].map((priority) => (
          <button
            key={priority}
            type="button"
            onClick={() => handlePriorityChange(String(priority))}
            className={cn(
              LINEAR_EDIT_MENU_ITEM_WITH_ICON_CLASS,
              localPriority === priority && 'bg-accent/50'
            )}
          >
            <LinearPriorityIcon priority={priority} />
            {PRIORITY_LABELS[priority]}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}

function LinearEstimateRow({
  controller
}: {
  controller: LinearIssueEditController
}): React.JSX.Element {
  const {
    localEstimate,
    handleEstimateChange,
    estimatePending,
    estimatePopoverOpen,
    handleEstimatePopoverOpenChange,
    estimateInput,
    setEstimateInput,
    handleEstimateSubmit
  } = controller
  return (
    <Popover open={estimatePopoverOpen} onOpenChange={handleEstimatePopoverOpenChange}>
      <PopoverTrigger asChild>
        <IssuePanePropertyRow
          label={translate('auto.components.LinearItemDrawer.e6cd6f6d3e', 'Estimate')}
          pending={estimatePending}
          disabled={estimatePending}
          value={formatLinearEstimateLabel(localEstimate)}
        />
      </PopoverTrigger>
      <PopoverContent className="w-64" align="start">
        <div className="space-y-3 p-3">
          <div className="grid grid-cols-5 gap-1.5">
            {LINEAR_ESTIMATE_PRESETS.map((estimate) => (
              <button
                key={estimate}
                type="button"
                onClick={() => handleEstimateChange(estimate)}
                className={cn(
                  'flex h-8 items-center justify-center rounded-md border border-border text-sm hover:bg-accent',
                  localEstimate === estimate && 'border-primary bg-accent text-foreground'
                )}
              >
                {estimate}
              </button>
            ))}
          </div>
          <Input
            value={estimateInput}
            onChange={(event) => setEstimateInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                handleEstimateSubmit()
              }
            }}
            inputMode="numeric"
            placeholder={translate(
              'auto.components.LinearItemDrawer.fbb90300e2',
              'Custom estimate'
            )}
            className="h-8"
          />
          <div className="flex items-center justify-between gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => handleEstimateChange(null)}
            >
              {translate('auto.components.LinearItemDrawer.ceeb8c6153', 'Clear')}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={handleEstimateSubmit}
              disabled={estimatePending}
            >
              {estimatePending ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
              {translate('auto.components.LinearItemDrawer.b5675b0694', 'Save')}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function LinearLabelsRow({
  controller
}: {
  controller: LinearIssueEditController
}): React.JSX.Element {
  const {
    labels,
    localLabels,
    localLabelIds,
    labelSummary,
    labelsPending,
    labelPopoverOpen,
    setLabelPopoverOpen,
    handleLabelToggle
  } = controller
  return (
    <Popover open={labelPopoverOpen} onOpenChange={setLabelPopoverOpen}>
      <PopoverTrigger asChild>
        <IssuePanePropertyRow
          label={translate('auto.components.right.sidebar.IssuePane.labels', 'Labels')}
          pending={labelsPending}
          disabled={labelsPending}
          value={
            localLabels.length ? (
              labelSummary
            ) : (
              <span className="text-muted-foreground">
                {translate('auto.components.LinearItemDrawer.23886c7eec', 'Add label')}
              </span>
            )
          }
        />
      </PopoverTrigger>
      <PopoverContent className="w-52" align="start">
        <div className="max-h-64 overflow-y-auto scrollbar-sleek">
          {labels.error ? (
            <div className="px-2 py-3 text-center text-[12px] text-destructive">{labels.error}</div>
          ) : labels.loading ? (
            <div className="flex items-center gap-2 px-2 py-3 text-[12px] text-muted-foreground">
              <LoaderCircle className="size-3 animate-spin" />
              {translate('auto.components.LinearItemDrawer.cddd9b04a7', 'Loading labels')}
            </div>
          ) : (
            labels.data.map((label) => (
              <button
                key={label.id}
                type="button"
                onClick={() => handleLabelToggle(label.id)}
                className={LINEAR_EDIT_MENU_ITEM_WITH_ICON_CLASS}
              >
                <span
                  className={cn(
                    'flex size-3.5 items-center justify-center rounded-sm border',
                    localLabelIds.includes(label.id)
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-input'
                  )}
                >
                  {localLabelIds.includes(label.id) && checkIcon}
                </span>
                <span
                  className="inline-block size-2 rounded-full"
                  style={{ backgroundColor: label.color }}
                />
                {label.name}
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
