import type { JiraPriority } from '../../../shared/jira/jira-types'

export type JiraPrioritySeverity = 'blocker' | 'critical' | 'major' | 'standard'

// Why: a Jira instance can rename its priority scheme per project, so the standard
// vocabularies are matched by name and anything custom stays uncoloured.
const BLOCKER_PRIORITY_NAMES = new Set(['blocker', 'highest'])
const CRITICAL_PRIORITY_NAMES = new Set(['critical'])
const MAJOR_PRIORITY_NAMES = new Set(['major', 'high'])

type JiraPriorityLike = Pick<JiraPriority, 'name'> | null | undefined

export function getJiraPrioritySeverity(priority: JiraPriorityLike): JiraPrioritySeverity {
  const name = priority?.name?.trim().toLowerCase()
  if (!name) {
    return 'standard'
  }
  if (BLOCKER_PRIORITY_NAMES.has(name)) {
    return 'blocker'
  }
  if (CRITICAL_PRIORITY_NAMES.has(name)) {
    return 'critical'
  }
  return MAJOR_PRIORITY_NAMES.has(name) ? 'major' : 'standard'
}

// Why no chip palette here: `getJiraPriorityTone` in `task-page-jira-status-tone.ts` is the one
// every priority surface reads, so a board card and the issue-list cell cannot disagree about what
// "Major" looks like. This module owns only what upstream has no equivalent for: the severity tier
// and the blocker-only surface wash.

export type JiraPrioritySurfaceTone = {
  /** Wash for the whole task surface; empty for every tier except blocker. */
  base: string
  /** Border override, so a washed surface keeps its hue instead of the default hairline. */
  border: string
  /** Hover wash, so a blocker stays red instead of turning into the generic accent. */
  hover: string
  /** Selected wash, so selecting a blocker does not erase the severity. */
  selected: string
}

/**
 * A blocker is the one tier that repaints the entire task surface — a pill alone is too
 * easy to skim past on a dense board.
 */
export function getJiraPrioritySurfaceTone(priority: JiraPriorityLike): JiraPrioritySurfaceTone {
  if (getJiraPrioritySeverity(priority) !== 'blocker') {
    return { base: '', border: '', hover: 'hover:bg-accent', selected: 'bg-accent' }
  }
  return {
    base: 'bg-jira-priority-high/10',
    border: 'border-jira-priority-high/40',
    hover: 'hover:bg-jira-priority-high/15',
    selected: 'bg-jira-priority-high/15'
  }
}
