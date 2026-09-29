import type { JiraPriority } from '../../../shared/jira-types'

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

const SEVERITY_TONE: Record<JiraPrioritySeverity, string> = {
  blocker: 'border-severity-blocker/25 bg-severity-blocker/10 text-severity-blocker',
  // Critical shares blocker's red chip; the whole-surface wash is the only difference,
  // so the two stay separable without inventing a fourth hue.
  critical: 'border-severity-blocker/25 bg-severity-blocker/10 text-severity-blocker',
  major: 'border-severity-major/25 bg-severity-major/10 text-severity-major',
  standard: 'border-border/50 bg-muted/40 text-muted-foreground'
}

/** Tone for the priority pill on a task row or board card. */
export function getJiraPriorityTone(priority: JiraPriorityLike): string {
  return SEVERITY_TONE[getJiraPrioritySeverity(priority)]
}

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
    base: 'bg-severity-blocker/10',
    border: 'border-severity-blocker/40',
    hover: 'hover:bg-severity-blocker/15',
    selected: 'bg-severity-blocker/15'
  }
}
