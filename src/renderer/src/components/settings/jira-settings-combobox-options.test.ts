import { describe, expect, it } from 'vitest'
import type { JiraBoard, JiraField } from '../../../../shared/jira-types'
import {
  boardOptionValue,
  buildJiraBoardOptions,
  buildJiraTeamFieldOptions
} from './jira-settings-combobox-options'

const boards: JiraBoard[] = [
  { id: '42', name: 'Payments', type: 'scrum', siteId: 'site-1', siteName: 'Example Jira' }
]

const fields: JiraField[] = [
  {
    id: 'customfield_21400',
    name: 'Team',
    schemaType: 'any',
    siteId: 'site-1',
    siteName: 'Example Jira'
  },
  {
    id: 'customfield_20801',
    name: 'Assigned Team',
    schemaType: 'option',
    siteId: 'site-1',
    siteName: 'Example Jira'
  }
]

describe('jira settings combobox options', () => {
  it('labels boards with their site only when the list spans sites', () => {
    expect(buildJiraBoardOptions(boards, null, 'Board 42')).toEqual([
      { value: 'site-1:42', label: 'Payments' }
    ])
    expect(
      buildJiraBoardOptions(
        [...boards, { ...boards[0], id: '43', siteId: 'site-2', siteName: 'Other Jira' }],
        null,
        'Board 42'
      )
    ).toEqual([
      { value: 'site-1:42', label: 'Payments · Example Jira' },
      { value: 'site-2:43', label: 'Payments · Other Jira' }
    ])
  })

  it('keeps a saved board that the fetched page does not contain', () => {
    expect(
      buildJiraBoardOptions(boards, { boardId: '37169', siteId: 'site-1', name: 'Nebulite' }, 'x')
    ).toEqual([
      { value: 'site-1:37169', label: 'Nebulite' },
      { value: 'site-1:42', label: 'Payments' }
    ])
  })

  it('falls back to the caller label when the saved board has no stored name', () => {
    expect(
      buildJiraBoardOptions(boards, { boardId: '37169', siteId: 'site-1' }, 'Board 37169')[0]
    ).toEqual({ value: 'site-1:37169', label: 'Board 37169' })
  })

  it('does not duplicate a saved board that is already in the fetched page', () => {
    expect(
      buildJiraBoardOptions(boards, { boardId: '42', siteId: 'site-1', name: 'Payments' }, 'x')
    ).toEqual([{ value: 'site-1:42', label: 'Payments' }])
  })

  it('matches team fields by name or id and keeps one option per field id', () => {
    expect(buildJiraTeamFieldOptions(fields, 'assigned', false)).toEqual([
      { value: 'customfield_20801', label: 'Assigned Team (customfield_20801)' }
    ])
    expect(buildJiraTeamFieldOptions(fields, 'customfield_21400', false)).toEqual([
      { value: 'customfield_21400', label: 'Team (customfield_21400)' }
    ])
    expect(
      buildJiraTeamFieldOptions(
        [...fields, { ...fields[0], siteId: 'site-2', siteName: 'Other Jira' }],
        '',
        true
      )
    ).toEqual([
      { value: 'customfield_21400', label: 'Team (customfield_21400) · Example Jira' },
      {
        value: 'customfield_20801',
        label: 'Assigned Team (customfield_20801) · Example Jira'
      }
    ])
  })

  it('derives the same value from a board and from a saved selection', () => {
    expect(boardOptionValue(boards[0])).toBe('site-1:42')
  })
})
