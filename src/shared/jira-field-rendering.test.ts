import { describe, expect, it } from 'vitest'
import { isJiraStoryPointsField } from './jira-field-rendering'

const GREENHOPPER = 'com.pyxis.greenhopper.jira:jsw-story-points'
const FLOAT = 'com.atlassian.jira.plugin.system.customfieldtypes:float'

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
