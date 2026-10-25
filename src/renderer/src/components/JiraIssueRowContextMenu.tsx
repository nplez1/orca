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
import type { JiraIssue } from '../../../shared/jira/jira-types'
import { getJiraIssueRowActions, type JiraIssueRowWorkspaceAction } from './jira-issue-row-actions'
import { Popover, PopoverAnchor } from '@/components/ui/popover'
import { JiraPromptTemplatePopover } from './JiraPromptTemplatePopover'

/** The Jira task row and both board cards share one surface: right-click (or the
 *  platform context-menu key) opens every action the detail sheet declares, in one list. */
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
          <PopoverAnchor
            asChild
            ref={setAnchor}
            aria-keyshortcuts="Enter Space Shift+F10 ContextMenu"
            // Why synthesized, and why here: macOS has no Menu key and no Shift+F10
            // convention, so the browser emits nothing and the keyboard route has to be
            // built by hand. Doing it on the trigger is what gives every wrapped card the
            // route from one place. Windows and Linux do get a native `contextmenu` for a
            // focused element, and this is still safe there: cancelling the key press
            // suppresses Chromium's key-down event, and the Menu key's key-up one lands on
            // the already-open menu rather than on the card.
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) {
                return
              }
              if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) {
                return
              }
              event.preventDefault()
              const rect = event.currentTarget.getBoundingClientRect()
              event.currentTarget.dispatchEvent(
                new MouseEvent('contextmenu', {
                  bubbles: true,
                  cancelable: true,
                  view: window,
                  clientX: rect.left,
                  clientY: rect.top + rect.height / 2
                })
              )
            }}
          >
            {children}
          </PopoverAnchor>
        </ContextMenuTrigger>
        <ContextMenuContent
          // Why: the portalled menu is a React sibling of the trigger, so its clicks
          // bubble to the trigger's ancestors — never to the card itself, but a
          // surrounding click-to-focus or close-on-click handler would still see them.
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
