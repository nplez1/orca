import { useState } from 'react'
import type { JSX } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  JiraTransitionFieldsForm,
  type JiraTransitionSubmitOutcome
} from '@/components/jira-transition-fields-form'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { RuntimeJiraSettings } from '@/runtime/runtime-jira-client'
import {
  classifyTransitionRequirements,
  rejectedTransitionFieldKeys
} from '../../../../shared/jira/jira-transition-fields'
import type {
  JiraFieldErrors,
  JiraIssue,
  JiraIssueUpdate,
  JiraTransition
} from '../../../../shared/jira/jira-types'
import { IssuePanePropertyRow } from './IssuePanePropertyRow'

const MENU_ITEM_CLASS =
  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent'

function jiraStatusToneClass(categoryKey: string): string {
  if (categoryKey === 'done') {
    return 'bg-emerald-500'
  }
  if (categoryKey === 'indeterminate') {
    return 'bg-sky-500'
  }
  return 'bg-muted-foreground'
}

/**
 * Status row plus its transitions dialog, so the pane keeps only the row. A status
 * change whose screen requires fields collects them here through the same form the
 * Task view uses, and a refusal naming a field the issue already fills reopens it
 * with that field asked for rather than dropping the sentence.
 */
export function JiraStatusRow({
  issue,
  transitions,
  pending,
  providerSettings,
  onTransition
}: {
  issue: JiraIssue
  transitions: JiraTransition[]
  pending: boolean
  providerSettings: RuntimeJiraSettings
  onTransition: (
    updates: JiraIssueUpdate,
    transition: JiraTransition
  ) => Promise<JiraTransitionSubmitOutcome>
}): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const [selected, setSelected] = useState<JiraTransition | null>(null)
  const [rejectedFieldErrors, setRejectedFieldErrors] = useState<JiraFieldErrors>({})
  const [rejectedErrorMessages, setRejectedErrorMessages] = useState<string[]>([])
  const [errorReason, setErrorReason] = useState<string | null>(null)
  const forcedFieldKeys = selected
    ? rejectedTransitionFieldKeys(selected, rejectedFieldErrors)
    : new Set<string>()
  const requirement = selected ? classifyTransitionRequirements(selected, forcedFieldKeys) : null

  function reset(): void {
    setSelected(null)
    setRejectedFieldErrors({})
    setRejectedErrorMessages([])
    setErrorReason(null)
  }

  async function choose(transition: JiraTransition): Promise<void> {
    setMenuOpen(false)
    reset()
    setSelected(transition)
    if (classifyTransitionRequirements(transition).kind !== 'none') {
      return
    }
    const outcome = await onTransition({ transitionId: transition.id }, transition)
    if (outcome.ok) {
      reset()
      return
    }
    // Why reopened: Jira named fields it refused, so they have to be asked for. A
    // refusal that names none lands in this row's own dialog below.
    const forced = rejectedTransitionFieldKeys(transition, outcome.fieldErrors)
    if (forced.size > 0 && outcome.fieldErrors) {
      setRejectedFieldErrors(outcome.fieldErrors)
      setRejectedErrorMessages(outcome.errorMessages ?? [])
      return
    }
    // Why the dialog and not a toast: this surface reports its own refusals, and a
    // sentence beside an "Open in Jira" link is where the user finishes the move.
    setErrorReason(outcome.error)
  }

  return (
    <>
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverTrigger asChild>
          <IssuePanePropertyRow
            label={translate('auto.components.right.sidebar.IssuePane.status', 'Status')}
            pending={pending}
            disabled={pending || transitions.length === 0}
            value={
              <span className="flex items-center gap-1.5">
                <span
                  className={cn(
                    'size-2 shrink-0 rounded-full',
                    jiraStatusToneClass(issue.status.categoryKey)
                  )}
                  aria-hidden
                />
                <span className="min-w-0 truncate">{issue.status.name}</span>
              </span>
            }
          />
        </PopoverTrigger>
        <PopoverContent className="w-52" align="start">
          <div className="max-h-64 overflow-y-auto scrollbar-sleek">
            {transitions.map((transition) => (
              <button
                key={transition.id}
                type="button"
                onClick={() => void choose(transition)}
                className={MENU_ITEM_CLASS}
              >
                {transition.name}
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>

      <Dialog
        open={selected !== null && (requirement?.kind === 'form' || errorReason !== null)}
        onOpenChange={(open) => !open && !pending && reset()}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {translate('components.jiraStatusRow.title', 'Change {{value0}} to {{value1}}', {
                value0: issue.key,
                value1: selected?.name ?? ''
              })}
            </DialogTitle>
            {requirement?.kind === 'form' ? (
              <DialogDescription>
                {translate(
                  'components.jiraStatusRow.description',
                  'Jira requires these fields before it will apply this status change.'
                )}
              </DialogDescription>
            ) : (
              <DialogDescription>
                {translate(
                  'components.jiraStatusRow.refused',
                  'Jira refused this change. Review the reason below, or finish it in Jira.'
                )}
              </DialogDescription>
            )}
          </DialogHeader>
          {selected && requirement?.kind === 'form' ? (
            <JiraTransitionFieldsForm
              key={selected.id}
              transition={selected}
              pending={pending}
              providerSettings={providerSettings}
              siteId={issue.siteId}
              forcedFieldKeys={forcedFieldKeys}
              rejectedFieldErrors={rejectedFieldErrors}
              rejectedErrorMessages={rejectedErrorMessages}
              errorReason={errorReason}
              issueUrl={issue.url}
              onBack={reset}
              onSubmit={async (updates) => {
                const outcome = await onTransition(updates, selected)
                // Why here and not in the caller: this row owns the dialog, and a
                // committed move left it standing open with a live Submit that would
                // post the same transition id against the new status.
                if (outcome.ok) {
                  reset()
                }
                return outcome
              }}
            />
          ) : null}
          {selected && requirement?.kind !== 'form' && errorReason ? (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <p role="alert" className="min-w-0 flex-1">
                {errorReason}
              </p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="-my-1 shrink-0"
                onClick={() => void window.api.shell.openUrl(issue.url)}
              >
                {translate('auto.components.JiraIssueWorkspace.69da9a208c', 'Open in Jira')}
              </Button>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={reset} disabled={pending}>
              {translate('auto.components.TaskPage.ff69a30681', 'Cancel')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
