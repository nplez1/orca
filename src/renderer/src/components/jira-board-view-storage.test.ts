// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { defaultJiraBoardViewPreferences } from '../../../shared/jira-board-view-preferences'
import {
  loadJiraBoardDevicePick,
  loadJiraBoardViewPreferences,
  saveJiraBoardDevicePick,
  saveJiraBoardViewPreferences,
  updateJiraBoardViewPreferences
} from './jira-board-view-storage'

const STORAGE_KEY = 'orca.jira.board-view.v1'

describe('Jira board view local storage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('falls back to defaults when nothing is stored', () => {
    expect(loadJiraBoardViewPreferences()).toEqual(defaultJiraBoardViewPreferences())
  })

  it('round-trips a non-default view', () => {
    const preferences = {
      viewMode: 'list' as const,
      activeView: 'backlog' as const,
      filter: 'all' as const,
      query: 'payments'
    }

    saveJiraBoardViewPreferences(preferences)

    expect(loadJiraBoardViewPreferences()).toEqual(preferences)
  })

  it('updates one field without dropping the others', () => {
    saveJiraBoardViewPreferences({
      viewMode: 'list',
      activeView: 'backlog',
      filter: 'all',
      query: 'payments'
    })

    updateJiraBoardViewPreferences({ query: '' })

    expect(loadJiraBoardViewPreferences()).toEqual({
      viewMode: 'list',
      activeView: 'backlog',
      filter: 'all',
      query: ''
    })
  })

  it('clears the key when the view returns to defaults', () => {
    saveJiraBoardViewPreferences({ ...defaultJiraBoardViewPreferences(), filter: 'all' })

    saveJiraBoardViewPreferences(defaultJiraBoardViewPreferences())

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(loadJiraBoardViewPreferences()).toEqual(defaultJiraBoardViewPreferences())
  })

  it('falls back to defaults when the stored value is unparseable', () => {
    localStorage.setItem(STORAGE_KEY, '{not json')

    expect(loadJiraBoardViewPreferences()).toEqual(defaultJiraBoardViewPreferences())
  })
})

describe('Jira board view preferences per board', () => {
  const BY_BOARD_KEY = 'orca.jira.board-view.by-board.v1'
  const SELECTION_KEY = 'orca.jira.board-selection.v1'
  const payments = 'site-1%3A42'
  const platform = 'site-2%3A7'

  beforeEach(() => {
    localStorage.clear()
  })

  it('keeps each board own view without disturbing the global value or other boards', () => {
    saveJiraBoardViewPreferences({
      viewMode: 'board',
      activeView: 'sprint',
      filter: 'me',
      query: ''
    })
    saveJiraBoardViewPreferences(
      { viewMode: 'list', activeView: 'backlog', filter: 'all', query: 'payments' },
      payments
    )

    expect(loadJiraBoardViewPreferences(payments)).toEqual({
      viewMode: 'list',
      activeView: 'backlog',
      filter: 'all',
      query: 'payments'
    })
    // Why: the global key is this device's last-used snapshot, so it follows the newest write.
    expect(loadJiraBoardViewPreferences()).toEqual({
      viewMode: 'list',
      activeView: 'backlog',
      filter: 'all',
      query: 'payments'
    })
    expect(loadJiraBoardViewPreferences(platform)).toEqual({
      viewMode: 'list',
      activeView: 'backlog',
      filter: 'all',
      query: ''
    })
  })

  it('adopts the pre-upgrade global view for the first board read, query included', () => {
    saveJiraBoardViewPreferences({
      viewMode: 'list',
      activeView: 'backlog',
      filter: 'all',
      query: 'kept'
    })

    expect(loadJiraBoardViewPreferences(payments).query).toBe('kept')
    expect(JSON.parse(localStorage.getItem(BY_BOARD_KEY) ?? '{}')).toEqual({
      migrated: true,
      boards: {
        [payments]: { viewMode: 'list', activeView: 'backlog', filter: 'all', query: 'kept' }
      }
    })
    // Why: after the migration a typed query belongs to one board and must not leak.
    expect(loadJiraBoardViewPreferences(platform)).toEqual({
      viewMode: 'list',
      activeView: 'backlog',
      filter: 'all',
      query: ''
    })
  })

  it('keeps a board own entry even when it is back at the defaults', () => {
    saveJiraBoardViewPreferences(
      { viewMode: 'list', activeView: 'sprint', filter: 'all', query: 'payments' },
      payments
    )
    saveJiraBoardViewPreferences(defaultJiraBoardViewPreferences(), payments)
    // Why: another board's filter must not leak in once this one is back at the defaults.
    saveJiraBoardViewPreferences(
      { ...defaultJiraBoardViewPreferences(), filter: 'all', query: 'platform' },
      platform
    )

    expect(loadJiraBoardViewPreferences(payments)).toEqual(defaultJiraBoardViewPreferences())
    expect(loadJiraBoardViewPreferences(platform)).toEqual({
      ...defaultJiraBoardViewPreferences(),
      filter: 'all',
      query: 'platform'
    })
  })

  it('falls back to the device view when either board payload is unparseable', () => {
    saveJiraBoardViewPreferences({
      viewMode: 'list',
      activeView: 'sprint',
      filter: 'me',
      query: ''
    })
    localStorage.setItem(BY_BOARD_KEY, '{not json')

    expect(loadJiraBoardViewPreferences(payments)).toEqual({
      viewMode: 'list',
      activeView: 'sprint',
      filter: 'me',
      query: ''
    })
  })

  it('round-trips the board this device last picked and clears it', () => {
    saveJiraBoardDevicePick({
      selection: { boardId: '42', siteId: 'site-1', name: 'Payments' },
      curated: true
    })

    expect(loadJiraBoardDevicePick()).toEqual({
      selection: { boardId: '42', siteId: 'site-1', name: 'Payments' },
      curated: true
    })
    expect(JSON.parse(localStorage.getItem(SELECTION_KEY) ?? 'null')).toEqual({
      boardId: '42',
      siteId: 'site-1',
      name: 'Payments',
      curated: true
    })

    saveJiraBoardDevicePick(null)
    expect(loadJiraBoardDevicePick()).toBeNull()
    expect(localStorage.getItem(SELECTION_KEY)).toBeNull()
  })

  it('ignores a stored pick that is not a board', () => {
    localStorage.setItem(SELECTION_KEY, JSON.stringify({ boardId: '', siteId: 'site-1' }))

    expect(loadJiraBoardDevicePick()).toBeNull()
  })
})
