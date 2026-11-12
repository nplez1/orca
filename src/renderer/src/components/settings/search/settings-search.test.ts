import { describe, expect, it } from 'vitest'
import { getAppearancePaneSearchEntries, getThemeEntries } from '../appearance/appearance-search'
import { getTerminalTypographySearchEntries } from '../terminal/appearance/terminal-typography-search'
import {
  getSettingsSectionSearchEntries,
  matchesSettingsSearch,
  rankSettingsSearchItems,
  scoreSettingsSearch,
  scoreSettingsSearchPhrase,
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

  it('matches a query that repeats one word', () => {
    expect(matchesSettingsSearch('theme theme', themeEntry)).toBe(true)
  })

  it('returns nothing when one word matches nothing', () => {
    expect(scoreSettingsSearch('dark zzz', themeEntry)).toBe(0)
    expect(matchesSettingsSearch('dark theme zzz', getThemeEntries())).toBe(false)
  })

  it('keeps the Appearance pane reachable from the search box', () => {
    const appearanceSectionEntries = getSettingsSectionSearchEntries({
      title: 'Appearance',
      description: 'Theme, zoom, app and terminal appearance, sidebars, and status bar.',
      searchEntries: getAppearancePaneSearchEntries()
    })
    expect(matchesSettingsSearch('dark theme', appearanceSectionEntries)).toBe(true)
  })

  // Why: a section header owns no rows, so a header-only word match would show an empty pane.
  it('does not split words across a section header title and description', () => {
    const sectionEntries = getSettingsSectionSearchEntries({
      title: 'Appearance',
      description: 'Theme, zoom, app and terminal appearance, sidebars, and status bar.',
      searchEntries: [{ title: 'App icon', description: 'Choose the dock icon.' }]
    })
    expect(matchesSettingsSearch('theme zoom', sectionEntries)).toBe(false)
    expect(matchesSettingsSearch('theme', sectionEntries)).toBe(true)
  })
})

describe('settings search ranking', () => {
  const tiersEntry: SettingsSearchEntry = {
    title: 'Theme',
    description: 'Appearance colors',
    keywords: ['dark']
  }

  it('keeps exact > prefix > substring and pane title > setting title > description > keyword', () => {
    expect(scoreSettingsSearch('theme', tiersEntry)).toBeGreaterThan(
      scoreSettingsSearch('them', tiersEntry)
    )
    expect(scoreSettingsSearch('them', tiersEntry)).toBeGreaterThan(
      scoreSettingsSearch('hem', tiersEntry)
    )
    const paneScore = scoreSettingsSearch('terminal', [
      { title: 'Terminal' },
      { title: 'Terminal font' }
    ])
    const settingTitleScore = scoreSettingsSearch('font', [{ title: 'Other' }, { title: 'Font' }])
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

  // Why: terminal theme target intent reads labels, so "dark mode theme" must not pick "Match dark mode".
  it('can match a label on the whole query only', () => {
    const lightThemeLabels: SettingsSearchEntry[] = [
      { title: 'Match dark mode', keywords: ['theme', 'light mode'] }
    ]
    expect(scoreSettingsSearch('dark mode theme', lightThemeLabels)).toBeGreaterThan(0)
    expect(scoreSettingsSearchPhrase('dark mode theme', lightThemeLabels)).toBe(0)
  })
})
