import { useRef, useState, type ReactNode } from 'react'
import { Clipboard, FileText } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { translate } from '@/i18n/i18n'
import type { JiraIssue } from '../../../shared/jira-types'
import { copyJiraTextToClipboard } from './jira-issue-workspace-actions'
import { buildJiraIssuePrompt } from './jira-prompt-templates'
import { Popover, PopoverAnchor } from '@/components/ui/popover'
import { JiraPromptTemplatePopover } from './JiraPromptTemplatePopover'

export function JiraIssueRowCopyMenu({
  issue,
  children
}: {
  issue: JiraIssue
  children: ReactNode
}): React.JSX.Element {
  const [templateOpen, setTemplateOpen] = useState(false)
  const anchorRef = useRef<HTMLElement | null>(null)
  const setAnchor = (element: HTMLDivElement | null) => {
    anchorRef.current = element
  }
  const actions = [
    {
      label: translate('auto.components.JiraIssueWorkspace.38839801e8', 'Copy key'),
      text: issue.key,
      copiedLabel: 'Key'
    },
    {
      label: translate('auto.components.JiraIssueWorkspace.779bb91ee0', 'Copy URL'),
      text: issue.url,
      copiedLabel: 'URL'
    },
    {
      label: translate('auto.components.JiraIssueWorkspace.0cc62bd690', 'Copy prompt'),
      text: buildJiraIssuePrompt(issue),
      copiedLabel: 'Prompt'
    }
  ]
  return (
    <Popover open={templateOpen} onOpenChange={setTemplateOpen}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <PopoverAnchor asChild ref={setAnchor}>
            {children}
          </PopoverAnchor>
        </ContextMenuTrigger>
        <ContextMenuContent
          onClick={(event) => event.stopPropagation()}
          onCloseAutoFocus={(event) => {
            if (templateOpen) {
              event.preventDefault()
            }
          }}
        >
          {actions.map((action) => (
            <ContextMenuItem
              key={action.copiedLabel}
              onSelect={() => void copyJiraTextToClipboard(action.text, action.copiedLabel)}
            >
              <Clipboard className="size-3.5" />
              {action.label}
            </ContextMenuItem>
          ))}
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
