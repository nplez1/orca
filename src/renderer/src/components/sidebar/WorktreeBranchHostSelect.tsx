import React from 'react'
import { ChevronDown } from 'lucide-react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { normalizeExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import type { BranchGroupMember } from './worktree-list/grouping/row-types'

type WorktreeBranchHostSelectProps = {
  members: readonly BranchGroupMember[]
  selectedHostId: ExecutionHostId
  groupKey: string
  onSelectHost?: (groupKey: string, hostId: ExecutionHostId) => void
  onPointerDown?: (event: React.PointerEvent<HTMLButtonElement>) => void
}

/** Per-card host switcher for a Group by branch card: one row per host. */
export const WorktreeBranchHostSelect = React.memo(function WorktreeBranchHostSelect({
  members,
  selectedHostId,
  groupKey,
  onSelectHost,
  onPointerDown
}: WorktreeBranchHostSelectProps) {
  const selectedLabel =
    members.find((member) => member.hostId === selectedHostId)?.hostLabel ??
    members[0]?.hostLabel ??
    ''
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-branch-host-select=""
          aria-label={translate(
            'auto.components.sidebar.WorktreeBranchHostSelect.label',
            'Select host'
          )}
          onPointerDown={(event) => {
            // Why: the card body activates the workspace on click; the switcher must not.
            event.stopPropagation()
            onPointerDown?.(event)
          }}
          onClick={(event) => event.stopPropagation()}
          className="inline-flex h-5 max-w-[7rem] shrink-0 items-center gap-0.5 rounded px-1 text-[10px] font-medium leading-none text-muted-foreground hover:bg-worktree-sidebar-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-worktree-sidebar-ring focus-visible:outline-none"
        >
          <span className="truncate">{selectedLabel}</span>
          <ChevronDown className="size-3 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuRadioGroup
          value={selectedHostId}
          onValueChange={(value) => {
            const hostId = normalizeExecutionHostId(value)
            if (hostId) {
              onSelectHost?.(groupKey, hostId)
            }
          }}
        >
          {members.map((member) => (
            <DropdownMenuRadioItem key={member.hostId} value={member.hostId}>
              {member.hostLabel}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
})
