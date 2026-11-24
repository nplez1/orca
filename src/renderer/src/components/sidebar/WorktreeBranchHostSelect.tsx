import React from 'react'
import { ChevronDown } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import {
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import type { BranchGroupMember } from '../../../../shared/sidebar-list/row-types'

type WorktreeBranchHostSelectProps = {
  members: readonly BranchGroupMember[]
  selectedHostId: ExecutionHostId
  groupKey: string
  onSelectHost?: (groupKey: string, hostId: ExecutionHostId) => void
  onPointerDown?: (event: React.PointerEvent<HTMLButtonElement>) => void
  menuAlign?: 'start' | 'end'
}

/** Per-card host switcher for a Group by branch card: one row per host. */
export const WorktreeBranchHostSelect = React.memo(function WorktreeBranchHostSelect({
  members,
  selectedHostId,
  groupKey,
  onSelectHost,
  onPointerDown,
  menuAlign = 'end'
}: WorktreeBranchHostSelectProps) {
  const t = useTranslate()
  const selectedLabel =
    members.find((member) => member.hostId === selectedHostId)?.hostLabel ??
    members[0]?.hostLabel ??
    ''
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        {/* Why the chip variant: the switcher stands in for the host label a mixed-host card has no
            chip for, and that variant keeps the two from drifting apart. */}
        <Badge asChild variant="hostContext" className="max-w-[7rem]">
          <button
            type="button"
            data-branch-host-select=""
            aria-label={t('auto.components.sidebar.WorktreeBranchHostSelect.label', 'Select host')}
            onPointerDown={(event) => {
              // Why: the card body activates the workspace on click; the switcher must not.
              event.stopPropagation()
              onPointerDown?.(event)
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <span className="truncate">{selectedLabel}</span>
            <ChevronDown className="shrink-0 opacity-70" />
          </button>
        </Badge>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={menuAlign} className="w-44">
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
