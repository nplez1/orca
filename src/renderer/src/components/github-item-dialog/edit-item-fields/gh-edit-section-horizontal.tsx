import React from 'react'
import { ArrowRight, ChevronDown, FolderKanban, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type { GitHubAssignableUser } from '../../../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { TaskPageGitHubCloseAction } from '@/components/task-page-github-status-actions'
import { translate } from '@/i18n/i18n'
import { GHEditSectionPills } from './gh-edit-section-pills'

export function GHEditSectionHorizontal({
  item,
  localState,
  localLabels,
  localAssignees,
  repoLabels,
  repoAssignees,
  repositoryLabelsUrl,
  attachedWorkspaceLabel,
  hasAttachedWorkspace,
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
  onLabelToggle,
  onOpenOrUseWorkspace,
  onUse
}: {
  item: GitHubWorkItem
  localState: GitHubWorkItem['state']
  localLabels: string[]
  localAssignees: string[]
  repoLabels: { data: string[]; loading: boolean; error: string | null }
  repoAssignees: { data: GitHubAssignableUser[]; loading: boolean; error: string | null }
  repositoryLabelsUrl: string | null
  attachedWorkspaceLabel?: string | null
  hasAttachedWorkspace: boolean
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
  onOpenOrUseWorkspace: () => void
  onUse: (item: GitHubWorkItem) => void
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/60 px-4 py-2.5">
      <GHEditSectionPills
        item={item}
        localState={localState}
        localLabels={localLabels}
        localAssignees={localAssignees}
        repoLabels={repoLabels}
        repoAssignees={repoAssignees}
        repositoryLabelsUrl={repositoryLabelsUrl}
        isStatePending={isStatePending}
        isAssigneesPending={isAssigneesPending}
        isLabelsPending={isLabelsPending}
        statusPopoverOpen={statusPopoverOpen}
        assigneePopoverOpen={assigneePopoverOpen}
        labelPopoverOpen={labelPopoverOpen}
        duplicatePickerOpen={duplicatePickerOpen}
        duplicateSearch={duplicateSearch}
        duplicateError={duplicateError}
        duplicatePickerTitle={duplicatePickerTitle}
        filteredDuplicateCandidates={filteredDuplicateCandidates}
        directDuplicateTarget={directDuplicateTarget}
        onStatusOpenChange={onStatusOpenChange}
        onAssigneeOpenChange={onAssigneeOpenChange}
        onLabelOpenChange={onLabelOpenChange}
        onStateChange={onStateChange}
        onDuplicateSearchChange={onDuplicateSearchChange}
        onDuplicateSearchSubmit={onDuplicateSearchSubmit}
        onCloseAsDuplicate={onCloseAsDuplicate}
        onBackFromDuplicate={onBackFromDuplicate}
        onOpenDuplicatePicker={onOpenDuplicatePicker}
        onAssigneeToggle={onAssigneeToggle}
        onLabelToggle={onLabelToggle}
      />
      <div className="ml-auto flex min-w-0 items-center gap-2">
        {attachedWorkspaceLabel ? (
          <span className="inline-flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
            <FolderKanban className="size-3 shrink-0" />
            <span className="truncate">{attachedWorkspaceLabel}</span>
          </span>
        ) : null}
        {hasAttachedWorkspace ? (
          <DropdownMenu modal={false}>
            <ButtonGroup>
              <Button
                type="button"
                size="sm"
                onClick={onOpenOrUseWorkspace}
                className="gap-2"
                aria-label={translate(
                  'auto.components.GitHubItemDialog.84855fedd0',
                  'Open workspace attached to issue'
                )}
              >
                {translate('auto.components.GitHubItemDialog.726db41722', 'Open workspace')}
                <ArrowRight className="size-4" />
              </Button>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  size="icon-sm"
                  aria-label={translate(
                    'auto.components.GitHubItemDialog.fe6ff12dc2',
                    'More issue workspace actions'
                  )}
                >
                  <ChevronDown className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
            </ButtonGroup>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => onUse(item)}>
                <Plus className="size-4" />
                {translate('auto.components.GitHubItemDialog.36182aa57f', 'Start new workspace')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Button
            type="button"
            size="sm"
            onClick={() => onUse(item)}
            className="gap-2"
            aria-label={translate(
              'auto.components.GitHubItemDialog.0ab4664a8b',
              'Start workspace from issue'
            )}
          >
            {translate('auto.components.GitHubItemDialog.0ab4664a8b', 'Start workspace from issue')}
            <ArrowRight className="size-4" />
          </Button>
        )}
      </div>
    </div>
  )
}
