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
  getAccountsDeepSeekSearchEntries,
  getAccountsFireworksSearchEntries,
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

describe('getAccountsDeepSeekSearchEntries', () => {
  it('returns a single entry for the DeepSeek balance flow', () => {
    const entries = getAccountsDeepSeekSearchEntries()
    expect(entries).toHaveLength(1)
    const [entry] = entries
    expect(entry.title).toBe('DeepSeek Usage')
    expect(entry.description.toLowerCase()).toContain('api key')
    expect(entry.description.toLowerCase()).toContain('balance')
  })

  it('exposes the keywords that drive the Settings search index', () => {
    const [entry] = getAccountsDeepSeekSearchEntries()
    expect(entry.keywords).toEqual(
      expect.arrayContaining(['deepseek', 'api key', 'balance', 'usage'])
    )
  })

  it('is included in the rolled-up pane search entries', () => {
    const titles = getAccountsPaneSearchEntries().map((entry) => entry.title)
    expect(titles).toContain('DeepSeek Usage')
  })
})

describe('getAccountsFireworksSearchEntries', () => {
  it('returns a single entry for the Fireworks.ai spend flow', () => {
    const entries = getAccountsFireworksSearchEntries()
    expect(entries).toHaveLength(1)
    const [entry] = entries
    expect(entry.title).toBe('Fireworks.ai Usage')
    expect(entry.description.toLowerCase()).toContain('api key')
    expect(entry.description.toLowerCase()).toContain('account id')
  })

  it('exposes the keywords that drive the Settings search index', () => {
    const [entry] = getAccountsFireworksSearchEntries()
    expect(entry.keywords).toEqual(
      expect.arrayContaining(['fireworks', 'api key', 'spend', 'usage'])
    )
  })

  it('is included in the rolled-up pane search entries', () => {
    const titles = getAccountsPaneSearchEntries().map((entry) => entry.title)
    expect(titles).toContain('Fireworks.ai Usage')
  })
})
