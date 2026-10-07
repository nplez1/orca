import { describe, expect, it } from 'vitest'
import { getOfferedIssueLinkProviders } from './issue-link-provider-options'

describe('getOfferedIssueLinkProviders', () => {
  it('offers only GitHub when nothing else is connected', () => {
    expect(getOfferedIssueLinkProviders({ connected: {}, selected: 'github' })).toEqual(['github'])
  })

  it('offers a provider once it is connected', () => {
    expect(
      getOfferedIssueLinkProviders({ connected: { linear: true }, selected: 'github' })
    ).toEqual(['github', 'linear'])
    expect(getOfferedIssueLinkProviders({ connected: { jira: true }, selected: 'github' })).toEqual(
      ['github', 'jira']
    )
  })

  // An existing link must stay visible and removable after a disconnect.
  it('keeps the selected provider even while disconnected', () => {
    expect(getOfferedIssueLinkProviders({ connected: {}, selected: 'linear' })).toEqual([
      'github',
      'linear'
    ])
  })

  it('keeps the canonical order regardless of connection', () => {
    expect(
      getOfferedIssueLinkProviders({ connected: { linear: true, jira: true }, selected: 'jira' })
    ).toEqual(['github', 'linear', 'jira'])
  })
})
