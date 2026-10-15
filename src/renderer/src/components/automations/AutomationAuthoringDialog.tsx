/**
 * Describe it: the entry point to the authoring conversation.
 *
 * There is no step editor anywhere in Orca, by design — a plan has an order, a
 * failure policy and a split between code and judgement, and a form that could
 * express all of that would be a worse authoring surface than the conversation
 * that produces it. So this dialog collects the description (and the project,
 * workspace and agent the form already holds are the context), opens an agent
 * session with the brief, and closes: the plan is proposed, corrected and applied
 * in that session, and the panel is where the result is managed afterwards.
 */

import React from 'react'
import { Wand2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'

const DESCRIPTION_PLACEHOLDER = translate(
  'auto.components.automations.AutomationAuthoringDialog.placeholder',
  'Every day at 7am: pull the latest on main, run setup, and build, so the newest build is ready when I start.'
)

export function AutomationAuthoringDialog({
  open,
  workspaceLabel,
  error,
  onOpenChange,
  onSubmit
}: {
  open: boolean
  /** Named in the dialog so the user can see which workspace the session opens in. */
  workspaceLabel: string | null
  /** Set when the session could not be opened, or the description was refused. */
  error: string | null
  onOpenChange: (open: boolean) => void
  onSubmit: (description: string) => void
}): React.JSX.Element {
  const [description, setDescription] = React.useState('')
  const trimmed = description.trim()
  const submit = (): void => {
    if (!trimmed) {
      return
    }
    onSubmit(trimmed)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {translate(
              'auto.components.automations.AutomationAuthoringDialog.title',
              'Describe an automation'
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.automations.AutomationAuthoringDialog.description',
              'An agent opens in the workspace, asks what it needs to know, proposes the steps, and creates the automation once you confirm. Prefer telling it what should happen rather than how.'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <Textarea
            autoFocus
            value={description}
            rows={5}
            placeholder={DESCRIPTION_PLACEHOLDER}
            aria-label={translate(
              'auto.components.automations.AutomationAuthoringDialog.descriptionLabel',
              'What should this automation do?'
            )}
            onChange={(event) => setDescription(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault()
                submit()
              }
            }}
          />
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.automations.AutomationAuthoringDialog.workspace',
              'The session opens in'
            )}
            {': '}
            {workspaceLabel ??
              translate(
                'auto.components.automations.AutomationAuthoringDialog.noWorkspace',
                'the workspace selected above'
              )}
          </p>
          {error ? (
            <p className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {translate('auto.components.automations.AutomationAuthoringDialog.close', 'Cancel')}
          </Button>
          <Button type="button" size="sm" disabled={!trimmed} onClick={submit}>
            <Wand2 className="size-4" />
            {translate(
              'auto.components.automations.AutomationAuthoringDialog.start',
              'Start authoring'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
