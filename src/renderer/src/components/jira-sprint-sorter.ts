import type { JiraSprint } from '../../../shared/jira/jira-types'
import { compareNumericLocaleText } from '../../../shared/locale-text-collators'

/**
 * Orders sprints for a picker: the issue's current sprint, then active ones, then the
 * future ones nearest today.
 *
 * Why not the board's own order: a production board accumulates hundreds of sprints,
 * most of them far in the past or far in the future (future-state sprints with stale
 * dates are common on long-lived boards). Only the ones around today are move targets
 * anyone reaches for. A sprint with no usable date sorts after every dated one, and the
 * caller's current sprint is pinned first — it is where the issue already is. */
export function sortJiraSprintsNearToday(
  sprints: readonly JiraSprint[],
  currentSprintId: string | null,
  now: number
): JiraSprint[] {
  return [...sprints].sort((a, b) => {
    const byState = stateRank(a, currentSprintId) - stateRank(b, currentSprintId)
    if (byState !== 0) {
      return byState
    }
    const distanceA = distanceFromToday(a.startDate, now)
    const distanceB = distanceFromToday(b.startDate, now)
    if (distanceA !== distanceB) {
      return distanceA < distanceB ? -1 : 1
    }
    const byStart = (a.startDate ?? '').localeCompare(b.startDate ?? '')
    // Why numeric: an undated board's sprints are named "Sprint 9", "Sprint 10", and a
    // plain compare puts 10 before 9.
    return byStart !== 0 ? byStart : compareNumericLocaleText(a.name, b.name)
  })
}

function stateRank(sprint: JiraSprint, currentSprintId: string | null): number {
  if (sprint.id === currentSprintId) {
    return 0
  }
  if (sprint.state === 'active') {
    return 1
  }
  return sprint.state === 'future' ? 2 : 3
}

function distanceFromToday(startDate: string | undefined, now: number): number {
  if (!startDate) {
    return Number.POSITIVE_INFINITY
  }
  const started = Date.parse(startDate)
  return Number.isFinite(started) ? Math.abs(started - now) : Number.POSITIVE_INFINITY
}
