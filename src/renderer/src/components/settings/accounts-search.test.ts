import { describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/i18n/localized-catalog', () => ({
  createLocalizedCatalog:
    <T>(loader: () => T) =>
    () =>
      loader()
}))

vi.mock('./settings-search-keywords', () => ({
  translateSearchKeyword: (_key: string, fallback: string) => [fallback]
}))

import {
  getAccountsCopilotSearchEntries,
  getAccountsMiniMaxSearchEntries,
  getAccountsPaneSearchEntries
} from './accounts-search'

describe('getAccountsMiniMaxSearchEntries', () => {
  it('returns a single entry that targets the MiniMax session cookie flow', () => {
    const entries = getAccountsMiniMaxSearchEntries()
    expect(entries).toHaveLength(1)
    const [entry] = entries
    expect(entry.title).toBe('MiniMax Usage')
    expect(entry.description.toLowerCase()).toContain('cookie')
    expect(entry.description.toLowerCase()).toContain('api key')
  })

  it('exposes the keywords that drive the Settings search index', () => {
    const [entry] = getAccountsMiniMaxSearchEntries()
    // Why: the Settings search needs at least one of these tokens to
    // surface the MiniMax section when the user types a related term.
    expect(entry.keywords).toEqual(
      expect.arrayContaining(['minimax', 'cookie', 'session', 'rate limit', 'status bar'])
    )
  })

  it('is included in the rolled-up pane search entries', () => {
    const allEntries = getAccountsPaneSearchEntries()
    const titles = allEntries.map((entry) => entry.title)
    expect(titles).toContain('MiniMax Usage')
  })
})

describe('getAccountsCopilotSearchEntries', () => {
  it('returns a single entry for the GitHub Copilot credit flow', () => {
    const entries = getAccountsCopilotSearchEntries()
    expect(entries).toHaveLength(1)
    const [entry] = entries
    expect(entry.title).toBe('GitHub Copilot Usage')
    expect(entry.description.toLowerCase()).toContain('github copilot ai credits')
    expect(entry.description.toLowerCase()).toContain('github cli sign-in')
  })

  it('exposes the keywords that drive the Settings search index', () => {
    const [entry] = getAccountsCopilotSearchEntries()
    expect(entry.keywords).toEqual(
      expect.arrayContaining(['copilot', 'github', 'ai credits', 'usage', 'token'])
    )
  })

  it('describes the flow the section configures, not a credential form it no longer has', () => {
    const [entry] = getAccountsCopilotSearchEntries()
    const description = entry.description.toLowerCase()

    expect(description).toContain('github cli sign-in')
    // The token and enterprise slug fields are gone, so the entry must not promise them.
    expect(description).not.toContain('enterprise')
    expect(description).not.toContain('slug')
    expect(description).not.toContain('billing')
  })

  it('is included in the rolled-up pane search entries', () => {
    const titles = getAccountsPaneSearchEntries().map((entry) => entry.title)
    expect(titles).toContain('GitHub Copilot Usage')
  })
})
