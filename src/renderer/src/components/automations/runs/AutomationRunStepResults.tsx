import { ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/class-names'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import type {
  AutomationStepOutcome,
  AutomationStepResult
} from '../../../../../shared/automations/steps/automation-step-results'
import { AUTOMATION_EDITOR_SECTION_LABEL_CLASS } from '../automation-page-parts'

function outcomeLabel(result: AutomationStepResult, t: Translate): string {
  const labels: Record<AutomationStepOutcome, string> = {
    succeeded: t('automations.scriptSteps.outcomeSucceeded', 'Succeeded'),
    failed:
      result.exitCode === null
        ? t('automations.scriptSteps.outcomeTerminated', 'Failed (no exit code)')
        : t('automations.scriptSteps.outcomeFailed', 'Failed (exit {{code}})', {
            code: result.exitCode
          }),
    cut_off: t('automations.scriptSteps.outcomeCutOff', 'Stopped at timeout'),
    unverifiable: t('automations.scriptSteps.outcomeUnverifiable', 'Could not run on this host'),
    unapproved: t('automations.scriptSteps.outcomeUnapproved', 'Needs approval')
  }
  return labels[result.outcome]
}

/** What each script step ran — path, arguments, content hash — and how it ended. */
export function AutomationRunStepResults({
  results,
  canReview,
  onReview
}: {
  results: readonly AutomationStepResult[]
  canReview: (result: AutomationStepResult) => boolean
  onReview?: (result: AutomationStepResult) => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <section className="min-w-0 rounded-lg border border-border/60">
      <h3
        className={cn(
          'border-b border-border/60 px-4 py-2.5 text-muted-foreground',
          AUTOMATION_EDITOR_SECTION_LABEL_CLASS
        )}
      >
        {t('automations.scriptSteps.runTitle', 'Script steps')}
      </h3>
      <ol className="divide-y divide-border/60">
        {results.map((result) => (
          <li key={result.stepId} className="flex min-w-0 flex-col gap-1.5 px-4 py-3">
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-mono text-xs text-foreground">{result.stepId}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                {[result.script, ...(result.args ?? [])].join(' ')}
              </span>
              <span
                className={cn(
                  'text-xs',
                  result.outcome === 'succeeded' ? 'text-muted-foreground' : 'text-destructive'
                )}
              >
                {outcomeLabel(result, t)}
              </span>
              <span className="text-xs text-muted-foreground">
                {t('automations.scriptSteps.duration', '{{seconds}}s', {
                  seconds: (result.durationMs / 1000).toFixed(1)
                })}
              </span>
              {onReview && canReview(result) ? (
                <Button type="button" variant="outline" size="xs" onClick={() => onReview(result)}>
                  <ShieldCheck />
                  {t('automations.scriptSteps.review', 'Review script')}
                </Button>
              ) : null}
            </div>
            {result.contentHash ? (
              <span className="truncate font-mono text-2xs text-muted-foreground">
                {t('automations.scriptSteps.contentHash', 'sha256 {{hash}}', {
                  hash: result.contentHash
                })}
              </span>
            ) : null}
            {result.error ? <p className="text-xs text-destructive">{result.error}</p> : null}
            {result.output ? (
              <pre className="max-h-40 overflow-auto rounded-md bg-muted/35 px-3 py-2 font-mono text-xs whitespace-pre-wrap break-all text-foreground scrollbar-sleek">
                {result.output}
              </pre>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  )
}
