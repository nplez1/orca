import React, { useCallback, useMemo } from 'react'
import { useAppStore } from '@/store'
import {
  DropdownMenuCheckboxItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { getWorkspaceStatusVisualMeta } from './workspace-status'
import { translate } from '@/i18n/i18n'

type SidebarWorkspaceStatusFilterSectionProps = {
  preserveWorkspaceBoardOpen?: boolean
}

const SidebarWorkspaceStatusFilterSection = React.memo(
  function SidebarWorkspaceStatusFilterSection({
    preserveWorkspaceBoardOpen = false
  }: SidebarWorkspaceStatusFilterSectionProps) {
    const workspaceStatuses = useAppStore((s) => s.workspaceStatuses)
    const hiddenWorkspaceStatusIds = useAppStore((s) => s.hiddenWorkspaceStatusIds)
    const setHiddenWorkspaceStatusIds = useAppStore((s) => s.setHiddenWorkspaceStatusIds)

    // Why derived from workspaceStatuses: a status removed elsewhere leaves a
    // stale id behind, and counting it would report a filter the user cannot see.
    const hiddenStatusIdSet = useMemo(() => {
      const set = new Set<string>()
      for (const status of workspaceStatuses) {
        if (hiddenWorkspaceStatusIds.includes(status.id)) {
          set.add(status.id)
        }
      }
      return set
    }, [workspaceStatuses, hiddenWorkspaceStatusIds])
    const hiddenCount = hiddenStatusIdSet.size

    const visibilityLabel =
      hiddenCount === 0
        ? translate(
            'auto.components.sidebar.SidebarWorkspaceStatusFilterSection.bda5f9404e',
            'All statuses'
          )
        : translate(
            'auto.components.sidebar.SidebarWorkspaceStatusFilterSection.63cf2888f5',
            '{{value0}} hidden',
            { value0: hiddenCount }
          )

    const toggleStatus = useCallback(
      (statusId: string, show: boolean) => {
        const isHidden = hiddenWorkspaceStatusIds.includes(statusId)
        if (show === !isHidden) {
          return
        }
        setHiddenWorkspaceStatusIds(
          show
            ? hiddenWorkspaceStatusIds.filter((id) => id !== statusId)
            : [...hiddenWorkspaceStatusIds, statusId]
        )
      },
      [hiddenWorkspaceStatusIds, setHiddenWorkspaceStatusIds]
    )

    const showAll = useCallback(
      () => setHiddenWorkspaceStatusIds([]),
      [setHiddenWorkspaceStatusIds]
    )

    if (workspaceStatuses.length === 0) {
      return null
    }

    // Why the Sort-by-style single row: label left, visibility summary right,
    // with the checkbox list nested so the parent menu stays flat.
    return (
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <span className="flex flex-1 items-center justify-between gap-3">
            <span>
              {translate(
                'auto.components.sidebar.SidebarWorkspaceStatusFilterSection.040f28a2a6',
                'Status'
              )}
            </span>
            <span className="min-w-0 truncate text-[11px] font-medium text-muted-foreground">
              {visibilityLabel}
            </span>
          </span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent
          className="w-56"
          data-workspace-board-preserve-open={preserveWorkspaceBoardOpen ? '' : undefined}
        >
          <div className="flex items-center justify-between px-2 py-1">
            <span className="text-[11px] font-semibold text-muted-foreground">
              {translate(
                'auto.components.sidebar.SidebarWorkspaceStatusFilterSection.040f28a2a6',
                'Status'
              )}
            </span>
            <button
              type="button"
              onClick={showAll}
              className="rounded-full px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40 disabled:hover:bg-transparent"
              disabled={hiddenCount === 0}
            >
              {translate(
                'auto.components.sidebar.SidebarWorkspaceStatusFilterSection.66ae0c2967',
                'Show all'
              )}
            </button>
          </div>
          {workspaceStatuses.map((status) => {
            const meta = getWorkspaceStatusVisualMeta(status)
            return (
              <DropdownMenuCheckboxItem
                key={status.id}
                checked={!hiddenStatusIdSet.has(status.id)}
                onCheckedChange={(checked) => toggleStatus(status.id, checked === true)}
                // Keep the submenu open so several statuses can be toggled in one pass.
                onSelect={(e) => e.preventDefault()}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <meta.icon className={cn('size-3.5 shrink-0', meta.tone)} />
                  <span className="truncate">{status.label}</span>
                </span>
              </DropdownMenuCheckboxItem>
            )
          })}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    )
  }
)

export default SidebarWorkspaceStatusFilterSection
