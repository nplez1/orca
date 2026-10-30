import { taskProviderErrorMessage, taskProviderErrorText } from '@/lib/task-provider-error-copy'
import { useState } from 'react'
import { ChevronDown, CircleAlert, ExternalLink, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import type { RuntimeJiraSettings } from '@/runtime/runtime-jira-client'
import {
  classifyTransitionRequirements,
  rejectedTransitionFieldKeys
} from '../../../shared/jira/jira-transition-fields'
import {
  JiraTransitionFieldsForm,
  type JiraTransitionSubmitOutcome
} from './jira-transition-fields-form'
import type {
  JiraFieldErrors,
  JiraIssue,
  JiraIssueUpdate,
  JiraMutationResult,
  JiraTransition
} from '../../../shared/jira/jira-types'
import { openAppHttpLink } from '@/lib/app-http-link-open'

type Props = {
  issue: JiraIssue
  transitions: JiraTransition[]
  loading: boolean
  error: string | null
  pending: boolean
  providerSettings?: RuntimeJiraSettings
  onRetry: () => void
  onTransition: (
    updates: JiraIssueUpdate,
    transition: JiraTransition
  ) => Promise<JiraMutationResult>
}

export function JiraIssueTransitionControl({
  issue,
  transitions,
  loading,
  error,
  pending,
  providerSettings,
  onRetry,
  onTransition
}: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<JiraTransition | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  // Why held here as well as in the form: a one-click transition that Jira refuses by
  // field never mounts the form, so this is what promotes it into one.
  const [rejectedFieldErrors, setRejectedFieldErrors] = useState<JiraFieldErrors>({})
  const [rejectedErrorMessages, setRejectedErrorMessages] = useState<string[]>([])
  const forcedFieldKeys = selected
    ? rejectedTransitionFieldKeys(selected, rejectedFieldErrors)
    : new Set<string>()
  const requirement = selected ? classifyTransitionRequirements(selected, forcedFieldKeys) : null
  const busy = pending || loading

  function reset(): void {
    setSelected(null)
    setSubmitError(null)
    setRejectedFieldErrors({})
    setRejectedErrorMessages([])
  }

  async function apply(
    transition: JiraTransition,
    updates: JiraIssueUpdate
  ): Promise<JiraTransitionSubmitOutcome> {
    try {
      const result = await onTransition(updates, transition)
      if (result.ok) {
        setOpen(false)
        reset()
        return { ok: true }
      }
      // Why returned rather than stored: the fields form owns its own rejection
      // so it can name the field Jira refused beside the control that failed.
      return {
        ok: false,
        error: taskProviderErrorMessage(result),
        ...(result.fieldErrors ? { fieldErrors: result.fieldErrors } : {}),
        ...(result.errorMessages ? { errorMessages: result.errorMessages } : {})
      }
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error
            ? taskProviderErrorText(error.message)
            : translate(
                'auto.components.JiraIssueWorkspace.ea21952aa3',
                'Failed to update Jira issue.'
              )
      }
    }
  }

  async function choose(transition: JiraTransition): Promise<void> {
    reset()
    setSelected(transition)
    if (classifyTransitionRequirements(transition).kind !== 'none') {
      return
    }
    const outcome = await apply(transition, { transitionId: transition.id })
    if (outcome.ok) {
      return
    }
    // Why reopened rather than reported flat: Jira named fields it refused, so the form
    // has to stand them up and let the user change them. A refusal that names nothing
    // keeps the plain sentence and the Jira link.
    const forced = rejectedTransitionFieldKeys(transition, outcome.fieldErrors)
    if (forced.size > 0 && outcome.fieldErrors) {
      setRejectedFieldErrors(outcome.fieldErrors)
      setRejectedErrorMessages(outcome.errorMessages ?? [])
      return
    }
    setSubmitError(outcome.error)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (pending) {
          return
        }
        setOpen(nextOpen)
        if (!nextOpen) {
          reset()
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="secondary"
          size="sm"
          aria-label={translate('jira.transitions.changeStatus', 'Change status: {{status}}', {
            status: issue.status.name
          })}
          aria-invalid={Boolean(error)}
          disabled={pending}
        >
          {issue.status.name}
          {loading || pending ? (
            <Loader2 className="size-3 animate-spin motion-reduce:animate-none" />
          ) : error ? (
            <CircleAlert className="size-3" />
          ) : (
            <ChevronDown className="size-3" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72" align="start" wheelScroll>
        <div className="scrollbar-sleek max-h-96 space-y-3 overflow-y-auto p-3">
          {error ? (
            <>
              <p className="text-xs text-destructive" role="alert">
                {translate('jira.transitions.loadError', 'Could not load status changes.')} {error}
              </p>
              <Button variant="secondary" size="sm" onClick={onRetry} disabled={loading}>
                {translate('jira.transitions.retry', 'Retry')}
              </Button>
            </>
          ) : loading ? (
            <p className="text-xs text-muted-foreground" role="status">
              {translate('jira.transitions.loading', 'Loading status changes…')}
            </p>
          ) : null}
          {requirement?.kind === 'form' && selected ? (
            <JiraTransitionFieldsForm
              key={selected.id}
              transition={selected}
              pending={busy || Boolean(error)}
              providerSettings={providerSettings}
              siteId={issue.siteId}
              forcedFieldKeys={forcedFieldKeys}
              rejectedFieldErrors={rejectedFieldErrors}
              rejectedErrorMessages={rejectedErrorMessages}
              errorReason={submitError}
              issueUrl={issue.url}
              onBack={reset}
              onSubmit={(updates) => apply(selected, updates)}
            />
          ) : error || loading ? null : selected && submitError ? null : transitions.length ===
            0 ? (
            <p className="text-xs text-muted-foreground">
              {translate('jira.transitions.empty', 'No status changes available.')}
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              {transitions.map((transition) => (
                <Button
                  key={transition.id}
                  variant="ghost"
                  size="sm"
                  className="justify-start"
                  disabled={busy}
                  onClick={() => void choose(transition)}
                >
                  {transition.name}
                </Button>
              ))}
            </div>
          )}
          {submitError ? (
            <p role="alert" className="text-xs text-destructive">
              {submitError}
            </p>
          ) : null}
          {submitError ? (
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={reset} disabled={busy}>
                {translate('jira.transitions.back', 'Back')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={(event) => openAppHttpLink(issue.url, { event })}
              >
                <ExternalLink className="size-3" />
                {translate('auto.components.JiraIssueWorkspace.69da9a208c', 'Open in Jira')}
              </Button>
            </div>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}
