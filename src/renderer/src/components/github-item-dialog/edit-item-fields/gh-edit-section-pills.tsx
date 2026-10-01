import type { GitHubAssignableUser } from '../../../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { TaskPageGitHubCloseAction } from '@/components/task-page-github-status-actions'
import { GHEditSectionStatusPopover } from './gh-edit-section-status-popover'
import { GHEditSectionAssigneesPill } from './gh-edit-section-assignees'
import { GHEditSectionLabelsPill } from './gh-edit-section-labels'

export type GHEditSectionPillsProps = {
  item: GitHubWorkItem
  localState: GitHubWorkItem['state']
  localLabels: string[]
  localAssignees: string[]
  repoLabels: { data: string[]; loading: boolean; error: string | null }
  repoAssignees: { data: GitHubAssignableUser[]; loading: boolean; error: string | null }
  repositoryLabelsUrl: string | null
  isStatePending: boolean
  isAssigneesPending: boolean
  isLabelsPending: boolean
  statusPopoverOpen: boolean
  assigneePopoverOpen: boolean
  labelPopoverOpen: boolean
  duplicatePickerOpen: boolean
  duplicateSearch: string
  duplicateError: string | null
  duplicatePickerTitle: string
  filteredDuplicateCandidates: GitHubWorkItem[]
  directDuplicateTarget: number | null
  onStatusOpenChange: (open: boolean) => void
  onAssigneeOpenChange: (open: boolean) => void
  onLabelOpenChange: (open: boolean) => void
  onStateChange: (newState: 'open' | 'closed', closeAction?: TaskPageGitHubCloseAction) => void
  onDuplicateSearchChange: (value: string) => void
  onDuplicateSearchSubmit: () => void
  onCloseAsDuplicate: (targetIssueNumber: number | string) => void
  onBackFromDuplicate: () => void
  onOpenDuplicatePicker: () => void
  onAssigneeToggle: (login: string) => void
  onLabelToggle: (label: string) => void
}

/** The status / labels / assignees pill row for a GitHub issue, without the
 *  workspace CTA. Shared by the Task view's `GHEditSectionHorizontal`, which
 *  appends the CTA, and the right-sidebar Issue pane, where the workspace
 *  already exists. */
export function GHEditSectionPills({
  item,
  localState,
  localLabels,
  localAssignees,
  repoLabels,
  repoAssignees,
  repositoryLabelsUrl,
  isStatePending,
  isAssigneesPending,
  isLabelsPending,
  statusPopoverOpen,
  assigneePopoverOpen,
  labelPopoverOpen,
  duplicatePickerOpen,
  duplicateSearch,
  duplicateError,
  duplicatePickerTitle,
  filteredDuplicateCandidates,
  directDuplicateTarget,
  onStatusOpenChange,
  onAssigneeOpenChange,
  onLabelOpenChange,
  onStateChange,
  onDuplicateSearchChange,
  onDuplicateSearchSubmit,
  onCloseAsDuplicate,
  onBackFromDuplicate,
  onOpenDuplicatePicker,
  onAssigneeToggle,
  onLabelToggle
}: GHEditSectionPillsProps): React.JSX.Element {
  return (
    <>
      <GHEditSectionStatusPopover
        item={item}
        variant="pill"
        localState={localState}
        isPending={isStatePending}
        statusPopoverOpen={statusPopoverOpen}
        duplicatePickerOpen={duplicatePickerOpen}
        duplicateSearch={duplicateSearch}
        duplicateError={duplicateError}
        duplicatePickerTitle={duplicatePickerTitle}
        filteredDuplicateCandidates={filteredDuplicateCandidates}
        directDuplicateTarget={directDuplicateTarget}
        onOpenChange={onStatusOpenChange}
        onStateChange={onStateChange}
        onDuplicateSearchChange={onDuplicateSearchChange}
        onDuplicateSearchSubmit={onDuplicateSearchSubmit}
        onCloseAsDuplicate={onCloseAsDuplicate}
        onBackFromDuplicate={onBackFromDuplicate}
        onOpenDuplicatePicker={onOpenDuplicatePicker}
      />
      <GHEditSectionLabelsPill
        localLabels={localLabels}
        repoLabels={repoLabels}
        repositoryLabelsUrl={repositoryLabelsUrl}
        isPending={isLabelsPending}
        popoverOpen={labelPopoverOpen}
        onPopoverOpenChange={onLabelOpenChange}
        onToggle={onLabelToggle}
      />
      <GHEditSectionAssigneesPill
        localAssignees={localAssignees}
        repoAssignees={repoAssignees}
        isPending={isAssigneesPending}
        popoverOpen={assigneePopoverOpen}
        onPopoverOpenChange={onAssigneeOpenChange}
        onToggle={onAssigneeToggle}
      />
    </>
  )
}
