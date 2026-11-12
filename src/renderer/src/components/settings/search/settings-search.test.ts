import { describe, expect, it } from 'vitest'
import { getAppearancePaneSearchEntries, getThemeEntries } from '../appearance/appearance-search'
import { getTerminalTypographySearchEntries } from '../terminal/appearance/terminal-typography-search'
import {
  SETTINGS_SEARCH_QUERY_MAX_BYTES,
  getSettingsSectionSearchEntries,
  matchesSettingsSearch,
  normalizeSettingsSearchQuery,
  rankSettingsSearchItems,
  scoreSettingsSearch,
  type SettingsSearchEntry
} from './settings-search'

const themeEntry: SettingsSearchEntry = {
  title: 'Theme',
  description: 'Choose how Orca looks in the app window.',
  keywords: ['dark', 'light', 'system']
}

describe('settings search multi-word queries', () => {
  it('matches when the words live in different fields of one entry', () => {
    expect(matchesSettingsSearch('dark theme', themeEntry)).toBe(true)
    expect(matchesSettingsSearch('theme dark', themeEntry)).toBe(true)
  })

  it('finds the appearance theme setting', () => {
    expect(matchesSettingsSearch('dark theme', getThemeEntries())).toBe(true)
  })

  it('keeps the Appearance pane reachable from the search box', () => {
    const appearanceSectionEntries = getSettingsSectionSearchEntries({
      title: 'Appearance',
      description: 'Theme, zoom, app and terminal appearance, sidebars, and status bar.',
      searchEntries: getAppearancePaneSearchEntries()
    })
    expect(matchesSettingsSearch('dark theme', appearanceSectionEntries)).toBe(true)
  })

  it('finds the terminal font size setting in any word order', () => {
    expect(matchesSettingsSearch('font size terminal', getTerminalTypographySearchEntries())).toBe(
      true
    )
    expect(matchesSettingsSearch('terminal font size', getTerminalTypographySearchEntries())).toBe(
      true
    )
  })

  it('splits on runs of whitespace', () => {
    expect(matchesSettingsSearch('dark   theme', themeEntry)).toBe(true)
    expect(matchesSettingsSearch('dark\ttheme', themeEntry)).toBe(true)
  })

  it('returns nothing when one word matches nothing', () => {
    expect(scoreSettingsSearch('dark zzz', themeEntry)).toBe(0)
    expect(matchesSettingsSearch('dark zzz', themeEntry)).toBe(false)
    expect(matchesSettingsSearch('dark theme zzz', getThemeEntries())).toBe(false)
  })

  // Why: a section only renders when one of its entries matched, so a hit always has a row to show.
  it('does not match when the words are split across entries', () => {
    expect(
      matchesSettingsSearch('terminal font', [{ title: 'Terminal' }, { title: 'Font size' }])
    ).toBe(false)
  })
})

describe('settings search ranking', () => {
  const tiersEntry: SettingsSearchEntry = {
    title: 'Theme',
    description: 'Appearance colors',
    keywords: ['dark']
  }

  it('keeps exact > prefix > substring for a single word', () => {
    expect(scoreSettingsSearch('theme', tiersEntry)).toBeGreaterThan(
      scoreSettingsSearch('them', tiersEntry)
    )
    expect(scoreSettingsSearch('them', tiersEntry)).toBeGreaterThan(
      scoreSettingsSearch('hem', tiersEntry)
    )
    expect(scoreSettingsSearch('appearance', tiersEntry)).toBeGreaterThan(
      scoreSettingsSearch('ppearance', tiersEntry)
    )
    expect(scoreSettingsSearch('dark', tiersEntry)).toBeGreaterThan(
      scoreSettingsSearch('dar', tiersEntry)
    )
    expect(scoreSettingsSearch('dar', tiersEntry)).toBeGreaterThan(
      scoreSettingsSearch('ark', tiersEntry)
    )
  })

  it('keeps pane title > setting title > description > keyword for a single word', () => {
    const paneScore = scoreSettingsSearch('terminal', [
      { title: 'Terminal' },
      { title: 'Terminal font' }
    ])
    const settingTitleScore = scoreSettingsSearch('font', [{ title: 'Font size' }])
    const descriptionScore = scoreSettingsSearch('default', [
      { title: 'Font size', description: 'Default terminal font size' }
    ])
    const keywordScore = scoreSettingsSearch('typography', [
      { title: 'Font size', keywords: ['typography'] }
    ])
    expect(paneScore).toBeGreaterThan(settingTitleScore)
    expect(settingTitleScore).toBeGreaterThan(descriptionScore)
    expect(descriptionScore).toBeGreaterThan(keywordScore)
  })

  it('ranks a whole-phrase hit above a word-by-word hit', () => {
    const items: { id: string; entries: SettingsSearchEntry }[] = [
      { id: 'words', entries: { title: 'Font', description: 'size' } },
      { id: 'phrase', entries: { title: 'Font size' } }
    ]
    const ranked = rankSettingsSearchItems('font size', items, (item) => item.entries)
    expect(ranked.map(({ item }) => item.id)).toEqual(['phrase', 'words'])
  })

  it('scores a multi-word query by its weakest word', () => {
    const strong = { title: 'Font size' }
    const weak = { title: 'Font', description: 'size' }
    expect(scoreSettingsSearch('font size', strong)).toBeGreaterThan(
      scoreSettingsSearch('font size', weak)
    )
  })

  it('keeps the empty-query and oversized-query behaviour', () => {
    expect(scoreSettingsSearch('   ', themeEntry)).toBeGreaterThan(0)
    expect(rankSettingsSearchItems('  ', [themeEntry], (item) => item)).toHaveLength(1)
    expect(scoreSettingsSearch('x'.repeat(SETTINGS_SEARCH_QUERY_MAX_BYTES + 1), themeEntry)).toBe(0)
  })

  it('normalizes case, padding and the Turkish dotted İ', () => {
    expect(normalizeSettingsSearchQuery('  Dark Theme  ')).toBe('dark theme')
    expect(normalizeSettingsSearchQuery('İnput')).toBe('input')
  })
})
