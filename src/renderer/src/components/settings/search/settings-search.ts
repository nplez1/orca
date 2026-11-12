import { isClipboardTextByteLengthOverLimit } from '../../../../../shared/clipboard-text'

export type SettingsSearchEntry = {
  title: string
  description?: string
  keywords?: string[]
  cmdJKeywords?: string[]
  targetSectionId?: string
}

export const SETTINGS_SEARCH_QUERY_MAX_BYTES = 2 * 1024
const SETTINGS_SEARCH_NO_MATCH_SCORE = 0
const SETTINGS_SEARCH_EMPTY_QUERY_SCORE = 1

type SettingsSearchScoreTier = {
  exact: number
  prefix: number
  substring: number
}

type SettingsSearchRankCandidate<T> = {
  item: T
  index: number
  score: number
}

export type RankedSettingsSearchItem<T> = {
  item: T
  score: number
}

const PANE_TITLE_SCORE: SettingsSearchScoreTier = {
  exact: 900,
  prefix: 850,
  substring: 800
}

const ENTRY_TITLE_SCORE: SettingsSearchScoreTier = {
  exact: 700,
  prefix: 650,
  substring: 600
}

const DESCRIPTION_SCORE: SettingsSearchScoreTier = {
  exact: 500,
  prefix: 450,
  substring: 400
}

const KEYWORD_SCORE: SettingsSearchScoreTier = {
  exact: 300,
  prefix: 250,
  substring: 200
}

export function isSettingsSearchQueryTooLarge(
  query: string,
  maxBytes = SETTINGS_SEARCH_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}

// Turkish İ lowercases to i + U+0307; drop the dot so plain-i queries still match.
function foldSettingsSearchText(value: string): string {
  return value.toLowerCase().replaceAll('\u0307', '')
}

export function normalizeSettingsSearchQuery(query: string): string {
  return foldSettingsSearchText(query.trim())
}

function scoreSettingsSearchText(
  normalizedTerm: string,
  value: string | undefined,
  tier: SettingsSearchScoreTier
): number {
  if (!value) {
    return SETTINGS_SEARCH_NO_MATCH_SCORE
  }
  const normalizedValue = foldSettingsSearchText(value)
  if (normalizedValue === normalizedTerm) {
    return tier.exact
  }
  if (normalizedValue.startsWith(normalizedTerm)) {
    return tier.prefix
  }
  if (normalizedValue.includes(normalizedTerm)) {
    return tier.substring
  }
  return SETTINGS_SEARCH_NO_MATCH_SCORE
}

function scoreSettingsSearchValues(
  normalizedTerm: string,
  values: readonly string[] | undefined,
  tier: SettingsSearchScoreTier
): number {
  return (values ?? []).reduce(
    (score, value) => Math.max(score, scoreSettingsSearchText(normalizedTerm, value, tier)),
    SETTINGS_SEARCH_NO_MATCH_SCORE
  )
}

function tokenizeSettingsSearchQuery(normalizedQuery: string): string[] {
  return normalizedQuery.split(/\s+/).filter(Boolean)
}

/** Best tier one term reaches across an entry's fields, or no match. */
function scoreSettingsSearchEntryTerm(
  normalizedTerm: string,
  entry: SettingsSearchEntry,
  titleTier: SettingsSearchScoreTier
): number {
  return Math.max(
    scoreSettingsSearchText(normalizedTerm, entry.title, titleTier),
    scoreSettingsSearchText(normalizedTerm, entry.description, DESCRIPTION_SCORE),
    scoreSettingsSearchValues(normalizedTerm, entry.keywords, KEYWORD_SCORE)
  )
}

// An entry is only as good as the word it matches worst, so every word has to land in this entry.
function scoreSettingsSearchEntryTokens(
  tokens: readonly string[],
  entry: SettingsSearchEntry,
  titleTier: SettingsSearchScoreTier
): number {
  if (tokens.length === 0) {
    return SETTINGS_SEARCH_NO_MATCH_SCORE
  }
  return Math.min(...tokens.map((token) => scoreSettingsSearchEntryTerm(token, entry, titleTier)))
}

export function scoreSettingsSearch(
  query: string,
  entries: SettingsSearchEntry | SettingsSearchEntry[]
): number {
  if (isSettingsSearchQueryTooLarge(query)) {
    return SETTINGS_SEARCH_NO_MATCH_SCORE
  }
  const normalizedQuery = normalizeSettingsSearchQuery(query)
  if (!normalizedQuery) {
    return SETTINGS_SEARCH_EMPTY_QUERY_SCORE
  }

  const tokens = tokenizeSettingsSearchQuery(normalizedQuery)
  const values = Array.isArray(entries) ? entries : [entries]
  return values.reduce((score, entry, index) => {
    // The first entry is the pane title; rank it above setting titles.
    const titleTier = index === 0 ? PANE_TITLE_SCORE : ENTRY_TITLE_SCORE
    return Math.max(
      score,
      // Why keep the whole-query score: a phrase that already matched keeps today's rank.
      scoreSettingsSearchEntryTerm(normalizedQuery, entry, titleTier),
      scoreSettingsSearchEntryTokens(tokens, entry, titleTier)
    )
  }, SETTINGS_SEARCH_NO_MATCH_SCORE)
}

export function getSettingsSectionSearchEntries(section: {
  title: string
  description: string
  searchEntries: readonly SettingsSearchEntry[]
}): SettingsSearchEntry[] {
  // Ranking and filtering need the same pane entry so title-only hits render content.
  return [{ title: section.title, description: section.description }, ...section.searchEntries]
}

export function rankSettingsSearchItems<T>(
  query: string,
  items: readonly T[],
  getEntries: (item: T) => SettingsSearchEntry | SettingsSearchEntry[]
): RankedSettingsSearchItem<T>[] {
  if (isSettingsSearchQueryTooLarge(query)) {
    return []
  }
  if (!normalizeSettingsSearchQuery(query)) {
    return items.map((item) => ({ item, score: SETTINGS_SEARCH_EMPTY_QUERY_SCORE }))
  }

  return items
    .map((item, index): SettingsSearchRankCandidate<T> => ({
      item,
      index,
      score: scoreSettingsSearch(query, getEntries(item))
    }))
    .filter((candidate) => candidate.score > SETTINGS_SEARCH_NO_MATCH_SCORE)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ item, score }) => ({ item, score }))
}

export function matchesSettingsSearch(
  query: string,
  entries: SettingsSearchEntry | SettingsSearchEntry[]
): boolean {
  return scoreSettingsSearch(query, entries) > SETTINGS_SEARCH_NO_MATCH_SCORE
}
