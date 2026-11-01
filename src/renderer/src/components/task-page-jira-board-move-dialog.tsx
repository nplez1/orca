import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import type { RuntimeJiraSettings } from '@/runtime/runtime-jira-client'
import {
  JiraTransitionFieldsForm,
  type JiraTransitionSubmitOutcome
} from './jira-transition-fields-form'
import {
  classifyTransitionRequirements,
  rejectedTransitionFieldKeys
} from '../../../shared/jira/jira-transition-fields'
import type {
  JiraFieldErrors,
  JiraIssue,
  JiraIssueUpdate,
  JiraTransition
} from '../../../shared/jira/jira-types'
import { openAppHttpLink } from '@/lib/app-http-link-open'

export type JiraBoardMovePrompt = {
  issue: JiraIssue
  destination: string
  transitions: JiraTransition[]
  selected: JiraTransition | null
  error: string | null
  /** Jira's field-level refusal from the last attempt, so the field it names is
   *  asked for again and can be changed. */
  fieldErrors?: JiraFieldErrors
  /** Jira's workflow messages from that refusal, which a field-level display hides. */
  errorMessages?: string[]
  loading: boolean
}

type Props = {
  prompt: JiraBoardMovePrompt | null
  pending: boolean
  providerSettings?: RuntimeJiraSettings
  onClose: () => void
  onChoose: (transition: JiraTransition) => void
  onSubmit: (updates: JiraIssueUpdate) => Promise<JiraTransitionSubmitOutcome>
  onRetry: () => void
}

export function JiraBoardMoveDialog({
  prompt,
  pending,
  providerSettings,
  onClose,
  onChoose,
  onSubmit,
  onRetry
}: Props): React.JSX.Element {
  const forcedFieldKeys = prompt?.selected
    ? rejectedTransitionFieldKeys(prompt.selected, prompt.fieldErrors)
    : new Set<string>()
  const requirement = prompt?.selected
    ? classifyTransitionRequirements(prompt.selected, forcedFieldKeys)
    : null
  return (
    <Dialog
      open={prompt !== null}
      onOpenChange={(open) => {
        if (!open && !pending) {
          onClose()
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {translate('jira.board.moveTitle', 'Move {{key}} to {{column}}', {
              key: prompt?.issue.key,
              column: prompt?.destination
            })}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'jira.board.moveDescription',
              'Jira controls which status changes are available and which fields they require.'
            )}
          </DialogDescription>
        </DialogHeader>
        {prompt?.loading ? (
          <p role="status" className="text-sm text-muted-foreground">
            {translate('jira.transitions.loading', 'Loading status changes…')}
          </p>
        ) : null}
        {prompt?.error ? (
          <p role="alert" className="text-sm text-destructive">
            {prompt.error}
          </p>
        ) : null}
        {!prompt?.selected && !prompt?.loading && prompt?.transitions.length ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm">
              {translate('jira.board.chooseTransition', 'Choose a status change:')}
            </p>
            {prompt.transitions.map((transition) => (
              <Button
                key={transition.id}
                variant="secondary"
                disabled={pending}
                onClick={() => onChoose(transition)}
              >
                {transition.name}
              </Button>
            ))}
          </div>
        ) : null}
        {requirement?.kind === 'form' && prompt?.selected ? (
          <JiraTransitionFieldsForm
            key={prompt.selected.id}
            transition={prompt.selected}
            pending={pending}
            providerSettings={providerSettings}
            siteId={prompt.issue.siteId}
            forcedFieldKeys={forcedFieldKeys}
            rejectedFieldErrors={prompt.fieldErrors}
            rejectedErrorMessages={prompt.errorMessages}
            errorReason={prompt.error}
            issueUrl={prompt.issue.url}
            onBack={onClose}
            onSubmit={onSubmit}
          />
        ) : null}
        {prompt && prompt.error ? (
          <div className="flex justify-end gap-2">
            <Button variant="ghost" disabled={pending} onClick={onClose}>
              {translate('jira.board.cancel', 'Cancel')}
            </Button>
            {requirement?.kind === 'none' ? (
              <Button
                variant="secondary"
                disabled={pending}
                onClick={() => {
                  if (prompt?.selected) {
                    onChoose(prompt.selected)
                  }
                }}
              >
                {translate('jira.transitions.retry', 'Retry')}
              </Button>
            ) : !prompt.selected && prompt.transitions.length === 0 ? (
              <Button variant="secondary" disabled={pending || prompt.loading} onClick={onRetry}>
                {translate('jira.transitions.retry', 'Retry')}
              </Button>
            ) : null}
            <Button
              variant="secondary"
              data-link-url={prompt?.issue.url}
              onClick={(event) => {
                if (prompt) {
                  openAppHttpLink(prompt.issue.url, { event })
                }
              }}
            >
              <ExternalLink />
              {translate('auto.components.JiraIssueWorkspace.69da9a208c', 'Open in Jira')}
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
