import { useEffect, useRef, useState } from 'react'
import { ArrowRight, ChevronDown, FolderOpen, Layers } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { JiraIssue } from '../../../shared/jira-types'
import type { Worktree } from '../../../shared/worktree/types'

const HOLD_MS = 500

/** One control for both designs the row can no longer hold separately: the body
 *  opens or starts (the fork's open-or-start), while the caret and a press-and-hold
 *  on the body open the linked-workspace menu plus "Start new workspace". The whole
 *  control is 36px so the backlog's 64px action column still holds it next to the
 *  open-in-Jira button. */
export function JiraIssueWorkspaceSplitAction({
  issue,
  workspaces,
  onOpenOrStartWorkspace,
  onOpenWorkspace,
  onStartWorkspace
}: {
  issue: JiraIssue
  workspaces: readonly Worktree[]
  onOpenOrStartWorkspace?: (issue: JiraIssue) => void
  onOpenWorkspace?: (workspace: Worktree) => 'opened' | 'failed' | void
  onStartWorkspace?: (issue: JiraIssue) => void
}): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const heldRef = useRef(false)
  const linked = workspaces.length > 0

  useEffect(() => {
    return () => {
      if (holdTimer.current !== null) {
        clearTimeout(holdTimer.current)
      }
    }
  }, [])

  const clearHold = (): void => {
    if (holdTimer.current !== null) {
      clearTimeout(holdTimer.current)
      holdTimer.current = null
    }
  }

  const startHold = (event: React.PointerEvent<HTMLButtonElement>): void => {
    // Primary mouse press only: right-click or a touch long-press (the row's
    // context menu) would otherwise open both menus at once.
    if (!linked || event.button !== 0 || event.pointerType === 'touch') {
      return
    }
    heldRef.current = false
    clearHold()
    holdTimer.current = setTimeout(() => {
      heldRef.current = true
      setMenuOpen(true)
    }, HOLD_MS)
  }

  const openWorkspace = (workspace: Worktree): void => {
    // Why record here: the open-or-start path records in the composer hook, but the
    // per-workspace entry goes straight through openJiraIssueWorkspace and would
    // otherwise miss the feature interaction.
    if (onOpenWorkspace?.(workspace) === 'opened') {
      useAppStore.getState().recordFeatureInteraction('jira-tasks')
    }
  }

  const bodyLabel = linked
    ? translate(
        'auto.components.TaskPage.jiraOpenAttachedWorkspace',
        'Open workspace attached to {{value0}}',
        { value0: issue.key }
      )
    : translate('auto.components.TaskPage.ff90d0abc7', 'Start workspace from {{value0}}', {
        value0: issue.key
      })

  if (!linked) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            data-contextual-tour-target="tasks-start-workspace"
            onClick={(event) => {
              event.stopPropagation()
              onOpenOrStartWorkspace?.(issue)
            }}
            aria-label={bodyLabel}
          >
            <ArrowRight className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {translate('auto.components.TaskPage.9497f2787c', 'Start workspace')}
        </TooltipContent>
      </Tooltip>
    )
  }

  const caretLabel =
    workspaces.length === 1
      ? translate('jira.workspace.single', '1 workspace linked to {{key}}', { key: issue.key })
      : translate('jira.workspace.count', '{{count}} workspaces linked to {{key}}', {
          count: workspaces.length,
          key: issue.key
        })

  return (
    <DropdownMenu
      open={menuOpen}
      onOpenChange={(next) => {
        clearHold()
        // The open menu blocks the release click, so the body onClick never runs
        // to clear heldRef; reset it here so the next activation is not swallowed.
        heldRef.current = false
        setMenuOpen(next)
      }}
    >
      <ButtonGroup orientation="horizontal" className="shrink-0">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="default"
              size="icon-xs"
              data-contextual-tour-target="tasks-start-workspace"
              onPointerDown={startHold}
              onPointerUp={clearHold}
              onPointerLeave={clearHold}
              onPointerCancel={clearHold}
              onClick={(event) => {
                event.stopPropagation()
                clearHold()
                if (heldRef.current) {
                  heldRef.current = false
                  return
                }
                onOpenOrStartWorkspace?.(issue)
              }}
              aria-label={bodyLabel}
            >
              <FolderOpen className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {translate('auto.components.TaskPage.jiraShowWorkspace', 'Show workspace')}
          </TooltipContent>
        </Tooltip>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="default"
            size="icon-xs"
            className="h-6 w-3"
            onClick={(event) => event.stopPropagation()}
            aria-label={caretLabel}
          >
            <ChevronDown className="size-3" />
          </Button>
        </DropdownMenuTrigger>
      </ButtonGroup>
      <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
        {workspaces.map((workspace) => (
          <DropdownMenuItem key={workspace.id} onSelect={() => openWorkspace(workspace)}>
            <Layers className="size-3.5" />
            <span className="min-w-0 truncate">
              {workspace.displayName || workspace.branch || workspace.path}
            </span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onStartWorkspace?.(issue)}>
          <ArrowRight className="size-3.5" />
          {translate('jira.workspace.startAnother', 'Start new workspace')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
