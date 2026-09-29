import { describe, expect, it } from 'vitest'
import {
  defaultJiraBoardViewPreferences,
  isDefaultJiraBoardViewPreferences,
  normalizeJiraBoardViewPreferences,
  resolveJiraBoardViewPreferences
} from './jira-board-view-preferences'

describe('resolveJiraBoardViewPreferences', () => {
  it('opens on the board, sprint tab, viewer filter, and no query when nothing is persisted', () => {
    expect(resolveJiraBoardViewPreferences(undefined)).toEqual({
      viewMode: 'board',
      activeView: 'sprint',
      filter: 'me',
      query: ''
    })
  })

  it('restores a complete persisted view', () => {
    expect(
      resolveJiraBoardViewPreferences({
        viewMode: 'list',
        activeView: 'backlog',
        filter: 'all',
        query: 'payments'
      })
    ).toEqual({ viewMode: 'list', activeView: 'backlog', filter: 'all', query: 'payments' })
  })

  it('drops the retired team filter and unknown values instead of throwing', () => {
    expect(
      resolveJiraBoardViewPreferences({
        viewMode: 'board',
        activeView: 'sprint',
        filter: 'team',
        query: 'x'
      })
    ).toEqual({ viewMode: 'board', activeView: 'sprint', filter: 'me', query: 'x' })
    expect(resolveJiraBoardViewPreferences({ filter: 'all', extra: true })).toEqual({
      viewMode: 'board',
      activeView: 'sprint',
      filter: 'all',
      query: ''
    })
  })

  it('treats a non-object payload as defaults', () => {
    expect(resolveJiraBoardViewPreferences('nope')).toEqual(defaultJiraBoardViewPreferences())
    expect(resolveJiraBoardViewPreferences(null)).toEqual(defaultJiraBoardViewPreferences())
  })
})

describe('normalizeJiraBoardViewPreferences', () => {
  it('returns undefined for an all-defaults view so callers can clear the key', () => {
    expect(normalizeJiraBoardViewPreferences(defaultJiraBoardViewPreferences())).toBeUndefined()
    expect(isDefaultJiraBoardViewPreferences(defaultJiraBoardViewPreferences())).toBe(true)
  })

  it('keeps a single non-default field', () => {
    expect(normalizeJiraBoardViewPreferences({ activeView: 'backlog' })).toEqual({
      viewMode: 'board',
      activeView: 'backlog',
      filter: 'me',
      query: ''
    })
  })
})
