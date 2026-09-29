import React from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { CheckStepOutcomeIcon } from '@/components/check-step-outcome-icon'
import { formatBuildDuration } from '@/components/check-build-metadata'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { PRCheckJob, PRCheckStep } from '../../../../shared/github/check-types'
import { resolveStepOutcome } from './check-job-step-status'

/** Elapsed time for a settled step, or null while it is still running. */
function stepDurationMs(step: PRCheckStep): number | null {
  if (!step.startedAt || !step.completedAt) {
    return null
  }
  const started = Date.parse(step.startedAt)
  const completed = Date.parse(step.completedAt)
  if (Number.isNaN(started) || Number.isNaN(completed) || completed < started) {
    return null
  }
  return completed - started
}

/** Stable React key: the provider's own node id, with a name/timestamp fallback for providers without one. */
function stepKey(step: PRCheckStep): string {
  return step.id ?? `${step.name}:${step.startedAt ?? ''}`
}

/**
 * One node of the pipeline tree: a stage, and the steps it ran.
 *
 * Why nested rather than flat: a stage's steps are its internals, and Blue Ocean draws that
 * relationship as indentation. The failing (and still-running) stages open by default, so the
 * answer to "what broke" is visible without a click.
 */
function StageNode({ step }: { step: PRCheckStep }): React.JSX.Element {
  const outcome = resolveStepOutcome(step)
  const children = step.children ?? []
  const hasChildren = children.length > 0
  const [expanded, setExpanded] = React.useState(outcome === 'failure' || outcome === 'pending')
  const durationMs = stepDurationMs(step)

  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-1.5 py-0.5">
        {hasChildren ? (
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            aria-label={translate('checkDetails.toggleStage', 'Toggle stage steps')}
            className="shrink-0 rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {expanded ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
          </button>
        ) : (
          <span className="size-3.5 shrink-0" />
        )}
        <CheckStepOutcomeIcon outcome={outcome} />
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-xs',
            outcome === 'skipped' ? 'text-muted-foreground' : 'text-foreground'
          )}
        >
          {step.name}
        </span>
        {durationMs !== null && (
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
            {formatBuildDuration(durationMs)}
          </span>
        )}
      </div>

      {step.errorMessage && outcome === 'failure' && (
        <div className="ml-[26px] mt-0.5 break-words font-mono text-[11px] text-destructive">
          {step.errorMessage}
        </div>
      )}

      {hasChildren && expanded && (
        <div className="ml-[13px] border-l border-border/60 pl-3">
          {children.map((child) => (
            <StageNode key={stepKey(child)} step={child} />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * A Jenkins stage list as a tree.
 *
 * One level of nesting is what `wfapi/describe` offers: the run lists its stages, and each
 * stage's own describe lists the steps it ran. Deeper declarative stages arrive as top-level
 * entries, so there is nothing below a step to draw.
 */
export function CheckStageTree({ job }: { job: PRCheckJob }): React.JSX.Element {
  return (
    <div className="mt-2 grid gap-0.5">
      {job.steps.map((step) => (
        <StageNode key={stepKey(step)} step={step} />
      ))}
    </div>
  )
}
