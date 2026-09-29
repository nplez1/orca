import type { JiraPriority } from '../../../shared/jira-types'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { getJiraPrioritySeverity, getJiraPriorityTone } from './task-page-jira-priority-tone'

/**
 * The severity chip for a Jira issue.
 *
 * Why a bubble plus a label: the hue alone is not readable for every user, and the
 * name alone made blocker/critical/major indistinguishable in a dense list.
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
        'inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] font-medium',
        getJiraPriorityTone(priority),
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
