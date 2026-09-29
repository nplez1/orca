import { beforeEach, describe, expect, it } from 'vitest'
import type { JiraBoardOverview, JiraIssue } from '../../../shared/jira-types'
import {
  clearTaskPageJiraBoardCache,
  patchTaskPageJiraBoardCache,
  readTaskPageJiraBoardCache,
  taskPageJiraBoardCacheKey,
  taskPageJiraBoardCacheSize,
  TASK_PAGE_JIRA_BOARD_CACHE_MAX_ENTRIES,
  TASK_PAGE_JIRA_BOARD_CACHE_TTL_MS
} from './task-page-jira-board-cache'

const key = taskPageJiraBoardCacheKey({ siteId: 'site-1', boardId: '42' })

function issue(key: string): JiraIssue {
  return {
    id: key,
    key,
    siteId: 'site-1',
    title: key,
    url: `https://example.atlassian.net/browse/${key}`,
    project: { id: 'project-1', key: 'ABC', name: 'Payments' },
    issueType: { id: 'story', name: 'Story' },
    status: { id: '1', name: 'Ready', categoryKey: 'new', categoryName: 'To Do' },
    labels: [],
    updatedAt: '2026-09-01T00:00:00.000Z',
    createdAt: '2026-09-01T00:00:00.000Z'
  }
}

function overview(boardId: string): JiraBoardOverview {
  return {
    board: { id: boardId, name: 'Payments', type: 'scrum', siteId: 'site-1', siteName: 'Example' },
    columns: [{ name: 'Ready', statusIds: ['1'] }],
    activeSprints: [{ id: '87', name: 'September sprint', state: 'active' }]
  }
}

beforeEach(() => {
  clearTaskPageJiraBoardCache()
})

describe('Jira board cache', () => {
  it('returns null for a board it has never seen', () => {
    expect(readTaskPageJiraBoardCache(key, 0)).toBeNull()
  })

  it('merges an overview patch with a later page patch', () => {
    patchTaskPageJiraBoardCache(key, { overview: overview('42'), activeSprintId: '87' }, 0)
    patchTaskPageJiraBoardCache(
      key,
      {
        sprint: { issues: [issue('ABC-1')], startAt: 1, pageToken: null, isLast: true, total: null }
      },
      0
    )

    expect(readTaskPageJiraBoardCache(key, 0)).toMatchObject({
      activeSprintId: '87',
      overview: { board: { id: '42' } },
      sprint: { issues: [{ key: 'ABC-1' }], startAt: 1, isLast: true },
      backlog: null
    })
  })

  it('hands out copies so a reader cannot mutate the snapshot', () => {
    patchTaskPageJiraBoardCache(
      key,
      {
        sprint: { issues: [issue('ABC-1')], startAt: 1, pageToken: null, isLast: true, total: null }
      },
      0
    )

    readTaskPageJiraBoardCache(key, 0)?.sprint?.issues.push(issue('ABC-2'))

    expect(readTaskPageJiraBoardCache(key, 0)?.sprint?.issues).toHaveLength(1)
  })

  it('expires a snapshot once the ttl passes', () => {
    patchTaskPageJiraBoardCache(key, { activeSprintId: '87' }, 0)

    expect(readTaskPageJiraBoardCache(key, TASK_PAGE_JIRA_BOARD_CACHE_TTL_MS - 1)).not.toBeNull()
    expect(readTaskPageJiraBoardCache(key, TASK_PAGE_JIRA_BOARD_CACHE_TTL_MS)).toBeNull()
  })

  it('evicts the least recently read board past the entry cap', () => {
    const keys = ['a', 'b', 'c', 'd'].map((boardId) =>
      taskPageJiraBoardCacheKey({ siteId: 'site-1', boardId })
    )
    keys.forEach((cacheKey, index) => patchTaskPageJiraBoardCache(cacheKey, {}, index))

    expect(taskPageJiraBoardCacheSize()).toBe(TASK_PAGE_JIRA_BOARD_CACHE_MAX_ENTRIES)
    expect(readTaskPageJiraBoardCache(keys[0], 3)).toBeNull()
    expect(readTaskPageJiraBoardCache(keys[3], 3)).not.toBeNull()
  })
})
