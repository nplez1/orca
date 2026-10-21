import { Fragment, useRef, useState, type ReactNode } from 'react'
import { FileText } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { translate } from '@/i18n/i18n'
import type { JiraIssue } from '../../../shared/jira-types'
import { getJiraIssueRowActions, type JiraIssueRowWorkspaceAction } from './jira-issue-row-actions'
import { Popover, PopoverAnchor } from '@/components/ui/popover'
import { JiraPromptTemplatePopover } from './JiraPromptTemplatePopover'

/** The Jira task row and board card share one surface: right-click (or the platform
 *  context-menu key) opens every action the detail sheet declares, in one list. */
export function JiraIssueRowContextMenu({
  issue,
  workspaceAction,
  children
}: {
  issue: JiraIssue
  workspaceAction: JiraIssueRowWorkspaceAction | null
  children: ReactNode
}): React.JSX.Element {
  const [templateOpen, setTemplateOpen] = useState(false)
  const anchorRef = useRef<HTMLElement | null>(null)
  const setAnchor = (element: HTMLDivElement | null) => {
    anchorRef.current = element
  }
  const actions = getJiraIssueRowActions(issue, workspaceAction)
  return (
    <Popover open={templateOpen} onOpenChange={setTemplateOpen}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <PopoverAnchor asChild ref={setAnchor}>
            {children}
          </PopoverAnchor>
        </ContextMenuTrigger>
        <ContextMenuContent
          // Why: the menu is portalled outside the triggering row, but a portal still
          // bubbles React events to the row, so a menu click would otherwise activate it.
          onClick={(event) => event.stopPropagation()}
          onCloseAutoFocus={(event) => {
            if (templateOpen) {
              event.preventDefault()
            }
          }}
        >
          {actions.map((action) => {
            const Icon = action.icon
            return (
              <Fragment key={action.key}>
                {action.separatorBefore ? <ContextMenuSeparator /> : null}
                <ContextMenuItem onSelect={action.onSelect}>
                  <Icon className="size-3.5" />
                  {action.label}
                </ContextMenuItem>
              </Fragment>
            )
          })}
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => setTemplateOpen(true)}>
            <FileText className="size-3.5" />
            {translate('jira.prompt.dialogTitle', 'Copy prompt from template')}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {templateOpen ? (
        <JiraPromptTemplatePopover
          issue={issue}
          onClose={() => setTemplateOpen(false)}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            anchorRef.current?.focus()
          }}
        />
      ) : null}
    </Popover>
  )
}
