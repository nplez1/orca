import { isClipboardTextByteLengthOverLimit } from '../../../../../shared/clipboard-text'

export type SettingsSearchEntry = {
  title: string
  description?: string
  keywords?: string[]
  cmdJKeywords?: string[]
  targetSectionId?: string
  /** Section header: matched as a whole query only, since it owns no rows. */
  isSectionHeader?: boolean
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
  normalizedValue: string,
  tier: SettingsSearchScoreTier
): number {
  if (!normalizedValue) {
    return SETTINGS_SEARCH_NO_MATCH_SCORE
  }
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
  normalizedValues: readonly string[],
  tier: SettingsSearchScoreTier
): number {
  return normalizedValues.reduce(
    (score, value) => Math.max(score, scoreSettingsSearchText(normalizedTerm, value, tier)),
    SETTINGS_SEARCH_NO_MATCH_SCORE
  )
}

function tokenizeSettingsSearchQuery(normalizedQuery: string): string[] {
  // Why dedupe: a repeated word cannot change the result, only the work per entry.
  return [...new Set(normalizedQuery.split(/\s+/).filter(Boolean))]
}

type FoldedSettingsSearchEntry = {
  title: string
  description: string
  keywords: readonly string[]
}

// Fold once per entry; a query re-scores every entry of every visible section on each keystroke.
function foldSettingsSearchEntry(entry: SettingsSearchEntry): FoldedSettingsSearchEntry {
  return {
    title: foldSettingsSearchText(entry.title),
    description: entry.description ? foldSettingsSearchText(entry.description) : '',
    keywords: (entry.keywords ?? []).map(foldSettingsSearchText)
  }
}

/** Best tier one term reaches across an entry's fields, or no match. */
function scoreFoldedSettingsSearchTerm(
  normalizedTerm: string,
  entry: FoldedSettingsSearchEntry,
  titleTier: SettingsSearchScoreTier
): number {
  return Math.max(
    scoreSettingsSearchText(normalizedTerm, entry.title, titleTier),
    scoreSettingsSearchText(normalizedTerm, entry.description, DESCRIPTION_SCORE),
    scoreSettingsSearchValues(normalizedTerm, entry.keywords, KEYWORD_SCORE)
  )
}

// Every word has to land in this entry, so a word that misses ends the entry.
function scoreFoldedSettingsSearchTerms(
  tokens: readonly string[],
  entry: FoldedSettingsSearchEntry,
  titleTier: SettingsSearchScoreTier
): number {
  let weakest: number | undefined
  for (const token of tokens) {
    const score = scoreFoldedSettingsSearchTerm(token, entry, titleTier)
    if (score === SETTINGS_SEARCH_NO_MATCH_SCORE) {
      return SETTINGS_SEARCH_NO_MATCH_SCORE
    }
    weakest = weakest === undefined ? score : Math.min(weakest, score)
  }
  return weakest ?? SETTINGS_SEARCH_NO_MATCH_SCORE
}

type SettingsSearchMatchMode = 'words' | 'phrase'

function scoreSettingsSearchEntries(
  query: string,
  entries: SettingsSearchEntry | SettingsSearchEntry[],
  matchMode: SettingsSearchMatchMode
): number {
  if (isSettingsSearchQueryTooLarge(query)) {
    return SETTINGS_SEARCH_NO_MATCH_SCORE
  }
  const normalizedQuery = normalizeSettingsSearchQuery(query)
  if (!normalizedQuery) {
    return SETTINGS_SEARCH_EMPTY_QUERY_SCORE
  }

  // Why whitespace rather than the token count: dedupe leaves "theme theme" one token, but it is
  // still a two-word query, and scoring it as a phrase would match nothing.
  const splitsWords = matchMode === 'words' && /\s/.test(normalizedQuery)
  const tokens = splitsWords ? tokenizeSettingsSearchQuery(normalizedQuery) : []
  const values = Array.isArray(entries) ? entries : [entries]
  return values.reduce((score, entry, index) => {
    // The first entry is the pane title; rank it above setting titles.
    const titleTier = index === 0 ? PANE_TITLE_SCORE : ENTRY_TITLE_SCORE
    const folded = foldSettingsSearchEntry(entry)
    // Why keep the whole-query score: a phrase that already matched keeps today's score.
    const phraseScore = scoreFoldedSettingsSearchTerm(normalizedQuery, folded, titleTier)
    // Why a section header is never split: it owns no rows, so a cross-word header match
    // would list a section whose body is empty.
    const wordScore =
      splitsWords && !entry.isSectionHeader
        ? scoreFoldedSettingsSearchTerms(tokens, folded, titleTier)
        : phraseScore
    return Math.max(score, phraseScore, wordScore)
  }, SETTINGS_SEARCH_NO_MATCH_SCORE)
}

export function scoreSettingsSearch(
  query: string,
  entries: SettingsSearchEntry | SettingsSearchEntry[]
): number {
  return scoreSettingsSearchEntries(query, entries, 'words')
}

/**
 * Whole query only. For callers that read a label — a theme name, a setting name — rather than
 * ranking rows, where splitting into words matches a different label than the one asked for.
 */
export function scoreSettingsSearchPhrase(
  query: string,
  entries: SettingsSearchEntry | SettingsSearchEntry[]
): number {
  return scoreSettingsSearchEntries(query, entries, 'phrase')
}

export function getSettingsSectionSearchEntries(section: {
  title: string
  description: string
  searchEntries: readonly SettingsSearchEntry[]
}): SettingsSearchEntry[] {
  // Ranking and filtering need the same pane entry so title-only hits render content.
  return [
    { title: section.title, description: section.description, isSectionHeader: true },
    ...section.searchEntries
  ]
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
