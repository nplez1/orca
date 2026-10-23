import { describe, expect, it } from 'vitest'
import {
  isJiraStoryPointsField,
  resolveJiraFieldControlKind,
  resolveJiraObjectListFieldKind
} from './jira-field-rendering'
import type { JiraCreateField } from './jira-types'

const GREENHOPPER = 'com.pyxis.greenhopper.jira:jsw-story-points'
const FLOAT = 'com.atlassian.jira.plugin.system.customfieldtypes:float'

function field(overrides: Partial<JiraCreateField> = {}): JiraCreateField {
  return { key: 'customfield_1', name: 'Field', required: false, schema: {}, ...overrides }
}

describe('resolveJiraFieldControlKind', () => {
  it('gives an option list a control that can name its options', () => {
    // The ids a multi-select holds mean nothing to the user, so it never gets the
    // comma-separated text box the string list gets.
    expect(
      resolveJiraFieldControlKind(
        field({
          schema: { type: 'array', items: 'option' },
          allowedValues: [{ id: '184354', value: 'mac-intel' }]
        })
      )
    ).toBe('optionList')
  })

  it('keeps a plain string list on the comma-separated text box', () => {
    expect(resolveJiraFieldControlKind(field({ schema: { type: 'array', items: 'string' } }))).toBe(
      'textList'
    )
  })

  it('gives a components field the picker its project list makes possible', () => {
    // Jira reports `array/items: string` for Component/s while holding objects, so the
    // string-list rule must not win once the project's own list is attached.
    expect(
      resolveJiraFieldControlKind(
        field({
          key: 'components',
          schema: { type: 'array', items: 'string', system: 'components' },
          allowedValues: [
            { id: '10400', name: 'Web' },
            { id: '10401', name: 'Platform' }
          ]
        })
      )
    ).toBe('optionList')
  })

  it('keeps the text box for a components field no project list was read for', () => {
    // An older host, or a read its permission denied: the submission then sends names.
    expect(
      resolveJiraFieldControlKind(
        field({
          key: 'components',
          schema: { type: 'array', items: 'string', system: 'components' }
        })
      )
    ).toBe('textList')
  })

  it('leaves an option list Jira names no values for unrenderable rather than guessing', () => {
    expect(resolveJiraFieldControlKind(field({ schema: { type: 'array', items: 'option' } }))).toBe(
      null
    )
  })

  it('gives a single option a select', () => {
    expect(
      resolveJiraFieldControlKind(
        field({ schema: { type: 'option' }, allowedValues: [{ id: '2', value: 'High' }] })
      )
    ).toBe('select')
  })
})

describe('resolveJiraObjectListFieldKind', () => {
  const objectList = (overrides: Partial<JiraCreateField>): JiraCreateField =>
    field({ schema: { type: 'array', items: 'string' }, ...overrides })

  it('names the project list each reference-holding system field needs', () => {
    expect(
      resolveJiraObjectListFieldKind(
        objectList({
          key: 'components',
          schema: { type: 'array', items: 'string', system: 'components' }
        })
      )
    ).toBe('components')
    expect(
      resolveJiraObjectListFieldKind(
        objectList({
          key: 'versions',
          schema: { type: 'array', items: 'string', system: 'versions' }
        })
      )
    ).toBe('versions')
    // One project list serves both version fields.
    expect(
      resolveJiraObjectListFieldKind(
        objectList({
          key: 'fixVersions',
          schema: { type: 'array', items: 'string', system: 'fixVersions' }
        })
      )
    ).toBe('versions')
  })

  it('falls back to the key when a site omits the system name', () => {
    expect(resolveJiraObjectListFieldKind(objectList({ key: 'components' }))).toBe('components')
    expect(
      resolveJiraObjectListFieldKind(objectList({ key: 'fixVersions', schema: { type: 'array' } }))
    ).toBe('versions')
  })

  it('leaves a genuine string list alone', () => {
    // Team and labels hold strings, and rewriting those as references would break them.
    expect(
      resolveJiraObjectListFieldKind(
        objectList({
          key: 'customfield_10002',
          schema: { type: 'array', items: 'string', custom: 'com.pyxis:team' }
        })
      )
    ).toBeNull()
    expect(resolveJiraObjectListFieldKind(objectList({ key: 'labels' }))).toBeNull()
    expect(resolveJiraObjectListFieldKind(field({ schema: { type: 'string' } }))).toBeNull()
  })
})

describe('isJiraStoryPointsField', () => {
  it("recognises Greenhopper's own story-points field whatever it is named", () => {
    expect(isJiraStoryPointsField({ name: 'Story Points', schema: { custom: GREENHOPPER } })).toBe(
      true
    )
    // Team-managed sites name the field in the site's language.
    expect(isJiraStoryPointsField({ name: 'Schätzung', schema: { custom: GREENHOPPER } })).toBe(
      true
    )
  })

  it('recognises the float field a site names "Story points"', () => {
    expect(isJiraStoryPointsField({ name: 'Story Points', schema: { custom: FLOAT } })).toBe(true)
    expect(
      isJiraStoryPointsField({ name: 'story point estimate', schema: { custom: FLOAT } })
    ).toBe(true)
  })

  it('leaves other number fields alone', () => {
    expect(isJiraStoryPointsField({ name: 'Budget', schema: { custom: FLOAT } })).toBe(false)
    expect(isJiraStoryPointsField({ name: 'Story Points', schema: { custom: 'x:other' } })).toBe(
      false
    )
    expect(isJiraStoryPointsField({ name: 'Story Points', schema: {} })).toBe(false)
    expect(isJiraStoryPointsField({})).toBe(false)
  })
})
