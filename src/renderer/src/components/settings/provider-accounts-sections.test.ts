import { describe, expect, it } from 'vitest'
import { USAGE_PROVIDER_IDS } from '../../../../shared/usage-provider-enablement'
import { getProviderAccountsSections } from './provider-accounts-sections'
import { getAccountsPaneSearchEntries } from './accounts-search'
import { matchesSettingsSearch } from './settings-search'

describe('getProviderAccountsSections', () => {
  it('covers exactly the providers whose usage can be switched off', () => {
    // Why: the pane's switch, the status bar's visibility and main's poll gate all
    // read USAGE_PROVIDER_IDS, so a provider missing here is one the user cannot
    // switch off, and one here without membership is a switch that does nothing.
    expect(
      getProviderAccountsSections()
        .map((provider) => provider.id)
        .sort()
    ).toEqual([...USAGE_PROVIDER_IDS].sort())
  })

  it('declares each provider once', () => {
    const ids = getProviderAccountsSections().map((provider) => provider.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('gives every provider a search entry, so search cannot hide it', () => {
    for (const provider of getProviderAccountsSections()) {
      expect(provider.searchEntries().length).toBeGreaterThan(0)
    }
  })

  it('reaches every provider from the pane-wide search catalog', () => {
    const catalog = getAccountsPaneSearchEntries()
    for (const provider of getProviderAccountsSections()) {
      for (const entry of provider.searchEntries()) {
        expect(catalog).toContainEqual(entry)
      }
    }
  })

  it('matches its own search entries, so no provider is unreachable by search', () => {
    for (const provider of getProviderAccountsSections()) {
      const title = provider.searchEntries()[0].title
      expect(matchesSettingsSearch(title, provider.searchEntries())).toBe(true)
    }
  })
})
