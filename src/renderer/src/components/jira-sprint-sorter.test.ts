import { describe, expect, it } from 'vitest'
import type { JiraSprint } from '../../../shared/jira/jira-types'
import { sortJiraSprintsNearToday } from './jira-sprint-sorter'

const NOW = Date.parse('2026-10-15T12:00:00.000Z')

function sprint(id: string, name: string, state: string, startDate?: string): JiraSprint {
  return { id, name, state, startDate }
}

/** A long-lived board: closed history, stale future-state sprints, and a far horizon. */
const busyBoard: JiraSprint[] = [
  sprint('closed-2024', 'Sprint 2024', 'closed', '2024-01-08T00:00:00.000Z'),
  sprint('future-2029', 'Sprint 2029', 'future', '2029-01-08T00:00:00.000Z'),
  sprint('stale-future', 'Sprint 2023 leftover', 'future', '2023-05-01T00:00:00.000Z'),
  sprint('next', 'October sprint', 'future', '2026-10-20T00:00:00.000Z'),
  sprint('later', 'November sprint', 'future', '2026-11-10T00:00:00.000Z'),
  sprint('active', 'September sprint', 'active', '2026-09-29T00:00:00.000Z'),
  sprint('undated', 'Backlog grooming', 'future')
]

describe('sortJiraSprintsNearToday', () => {
  it('puts the sprints around today first and the stale or distant ones last', () => {
    const ordered = sortJiraSprintsNearToday(busyBoard, null, NOW)

    // Active, then the nearest future sprints, then everything far away in either
    // direction ordered by how far, then the undated and the closed ones.
    expect(ordered.map((entry) => entry.id)).toEqual([
      'active',
      'next',
      'later',
      'future-2029',
      'stale-future',
      'undated',
      'closed-2024'
    ])
  })

  it('pins the issue current sprint first even when it is closed', () => {
    const ordered = sortJiraSprintsNearToday(busyBoard, 'closed-2024', NOW)

    expect(ordered[0]?.id).toBe('closed-2024')
    expect(ordered[1]?.id).toBe('active')
  })

  it('keeps an active sprint ahead of a nearer-dated future one', () => {
    const ordered = sortJiraSprintsNearToday(
      [
        sprint('future-tomorrow', 'Tomorrow', 'future', '2026-10-16T00:00:00.000Z'),
        sprint('active', 'Current', 'active', '2026-09-01T00:00:00.000Z')
      ],
      null,
      NOW
    )

    expect(ordered.map((entry) => entry.id)).toEqual(['active', 'future-tomorrow'])
  })

  it('ranks an unparseable start date with the undated sprints, not first', () => {
    const ordered = sortJiraSprintsNearToday(
      [
        sprint('broken', 'Broken date', 'future', 'not-a-date'),
        sprint('next', 'October sprint', 'future', '2026-10-20T00:00:00.000Z')
      ],
      null,
      NOW
    )

    expect(ordered.map((entry) => entry.id)).toEqual(['next', 'broken'])
  })

  it('orders undated sprints by their number, not by their digits', () => {
    const ordered = sortJiraSprintsNearToday(
      [
        sprint('a', 'Sprint 10', 'future'),
        sprint('b', 'Sprint 100', 'future'),
        sprint('c', 'Sprint 9', 'future')
      ],
      null,
      NOW
    )

    expect(ordered.map((entry) => entry.name)).toEqual(['Sprint 9', 'Sprint 10', 'Sprint 100'])
  })

  it('does not reorder the caller list', () => {
    const input = [...busyBoard]
    sortJiraSprintsNearToday(input, null, NOW)

    expect(input.map((entry) => entry.id)).toEqual(busyBoard.map((entry) => entry.id))
  })
})
