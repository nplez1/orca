import { CheckCircle2, CircleDashed, MinusCircle, XCircle } from 'lucide-react'
import type { StepOutcome } from '@/components/editor/check-job-step-status'

/**
 * The outcome glyph for one check step or CI stage.
 *
 * Why shared: the Checks sidebar and the full-details editor both list steps, and the two had
 * drifted — the sidebar printed the provider's raw vocabulary with no visual weight, so "which
 * stage is running" was only readable by reading every row.
 */
export function CheckStepOutcomeIcon({ outcome }: { outcome: StepOutcome }): React.JSX.Element {
  switch (outcome) {
    case 'success':
      return <CheckCircle2 className="size-3.5 shrink-0 text-status-success" />
    case 'failure':
      return <XCircle className="size-3.5 shrink-0 text-destructive" />
    case 'skipped':
      return <MinusCircle className="size-3.5 shrink-0 text-muted-foreground/60" />
    case 'pending':
      return <CircleDashed className="size-3.5 shrink-0 text-muted-foreground" />
  }
}
