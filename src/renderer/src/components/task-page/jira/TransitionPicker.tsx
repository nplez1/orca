import type { JSX } from 'react'
import type { JiraIssue, JiraTransition } from '../../../../../shared/jira-types'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'

type JiraTransitionPickerProps = {
  issue: JiraIssue | null
  transitions: JiraTransition[]
  onSelect: (transition: JiraTransition) => void
  onClose: () => void
  disabled: boolean
}

export function TaskPageJiraTransitionPicker({
  issue,
  transitions,
  onSelect,
  onClose,
  disabled
}: JiraTransitionPickerProps): JSX.Element {
  return (
    <Dialog open={issue !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {translate('auto.components.TaskPage.jiraChooseTransition', 'Choose a status change')}
          </DialogTitle>
          <DialogDescription>
            {issue
              ? translate(
                  'auto.components.TaskPage.jiraChooseTransitionDescription',
                  'More than one Jira transition can move {{value0}} to that column. Choose one to continue.',
                  { value0: issue.key }
                )
              : null}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {transitions.map((transition) => (
            <Button
              key={transition.id}
              type="button"
              variant="outline"
              className="w-full justify-start"
              disabled={disabled}
              onClick={() => onSelect(transition)}
            >
              {transition.name} · {transition.to.name}
            </Button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
