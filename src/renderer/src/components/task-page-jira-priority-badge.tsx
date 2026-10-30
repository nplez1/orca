import type { JiraPriority } from '../../../shared/jira/jira-types'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { getJiraPrioritySeverity } from './task-page-jira-priority-tone'
import { getJiraPriorityTone } from './task-page-jira-status-tone'

/**
 * The severity chip for a Jira issue.
 *
 * Why a bubble plus a label: the hue alone is not readable for every user. The tinted text is the
 * shared priority palette (`task-page-jira-status-tone.ts`), so it matches the issue-list cell; the
 * fill stays neutral, and it is `data-severity` plus the whole-surface wash that separates the tiers
 * — Critical and Major carry the same red as Blocker, differing only by the wash and the label.
 */
export function TaskPageJiraPriorityBadge({
  priority,
  className
}: {
  priority?: JiraPriority | null
  className?: string
}): React.JSX.Element {
  return (
    <span
      data-severity={getJiraPrioritySeverity(priority)}
      className={cn(
        // Why the explicit border and fill: `getJiraPriorityTone` is text-only by design (it is shared
        // with the list cells), so without these the pill falls back to the border token at full
        // opacity and loses its fill entirely.
        'inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-border/50 bg-muted/40 px-1.5 py-0.5 text-2xs font-medium',
        // Why upstream's function: one priority palette for the list cells and the board card.
        getJiraPriorityTone(priority?.name),
        className
      )}
    >
      <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden />
      <span className="min-w-0 truncate">
        {priority?.name ?? translate('auto.components.TaskPage.713179dfdc', 'No priority')}
      </span>
    </span>
  )
}
