import React from 'react'
import { XCircle } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { isFailedStepState } from '../../../../shared/check-step-visibility'
import type { PRCheckRunDetails, PRCheckStep } from '../../../../shared/github/check-types'

type FailureEntry = { key: string; label: string; message: string | null }

/** The deepest failure text under a stage, since a failed stage often only explains itself in its steps. */
function deepestChildMessage(step: PRCheckStep): string | null {
  if (step.errorMessage) {
    return step.errorMessage
  }
  for (const child of step.children ?? []) {
    const message = deepestChildMessage(child)
    if (message) {
      return message
    }
  }
  return null
}

function collectFailures(details: PRCheckRunDetails): FailureEntry[] {
  const entries: FailureEntry[] = []
  const multipleJobs = details.jobs.length > 1
  details.jobs.forEach((job, jobIndex) => {
    const failedSteps = job.steps.filter((step) =>
      isFailedStepState(step.conclusion ?? step.status)
    )
    for (const step of failedSteps) {
      entries.push({
        key: `${jobIndex}:${step.name}:${step.startedAt ?? ''}`,
        label: multipleJobs ? `${job.name} › ${step.name}` : step.name,
        message: deepestChildMessage(step)
      })
    }
    if (failedSteps.length === 0 && isFailedStepState(job.conclusion ?? job.status)) {
      entries.push({ key: `${jobIndex}:job`, label: job.name, message: null })
    }
  })
  return entries
}

/**
 * What went wrong, at the top of the details page.
 *
 * Why above the tree: the details page is reached from a failing check, and the failing stage is
 * routinely buried under hundreds of passing ones. This answers "what broke" before scrolling.
 */
export function CheckFailureSummary({
  details
}: {
  details: PRCheckRunDetails
}): React.JSX.Element | null {
  const failures = collectFailures(details)
  if (failures.length === 0) {
    return null
  }
  return (
    <section className="rounded-md border border-destructive/30 bg-destructive/5">
      <div className="flex items-center gap-2 border-b border-destructive/20 px-3 py-2 text-sm font-medium text-destructive">
        <XCircle className="size-4 shrink-0" />
        {translate('checkDetails.failures', 'Failures')}
        <span className="text-xs font-normal text-muted-foreground">{failures.length}</span>
      </div>
      <ul className="divide-y divide-destructive/10">
        {failures.map((failure) => (
          <li key={failure.key} className="min-w-0 px-3 py-2">
            <div className="break-words text-xs font-medium text-foreground">{failure.label}</div>
            {failure.message && (
              <div className="mt-0.5 break-words font-mono text-[11px] text-muted-foreground">
                {failure.message}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
