// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { defaultJiraBoardViewPreferences } from '../../../shared/jira-board-view-preferences'
import {
  loadJiraBoardViewPreferences,
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
