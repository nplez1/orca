import { matchQuickOpenSeparatorAlternatives } from './quick-open-separator-match'
import { isQuickOpenQueryTooLarge } from './quick-open-query-size-limits'
import {
  finalizeResults,
  retainTopResult,
  type QuickOpenRankedResult
} from './quick-open-bounded-result-page'

// Why: the query limits, the bounded result page and the name-filter matcher are their own
// modules; this file stays the single import site the host, relay and renderer already use.
export {
  QUICK_OPEN_QUERY_MAX_BYTES,
  QUICK_OPEN_REMOTE_QUERY_MAX_CODE_UNITS,
  isQuickOpenQueryTooLarge,
  isQuickOpenRemoteQueryTooLarge
} from './quick-open-query-size-limits'
export {
  NameFilterPathMatcher,
  pathMatchesQueryTokens,
  splitPathQueryTokens
} from './quick-open-name-filter-path-matcher'

export const QUICK_OPEN_RESULT_LIMIT = 50
export const QUICK_OPEN_SEARCH_VERSION = 3

export type QuickOpenIndexedFile = {
  path: string
  lowerPath: string
  lowerFilename: string
  inputIndex: number
}

export type QuickOpenSearchResult = {
  path: string
  score: number
}

/** A streaming path matcher: every match is counted, only a bounded page is retained. */
export type PathSearchMatcher = {
  consider(path: string): void
  result(): { paths: string[]; totalCount: number }
}

/**
 * `quick-open` ranks fuzzy subsequence matches; `name-filter` keeps substring-AND matches
 * (the Explore pane's filter semantics) in a sorted page.
 */
export type PathSearchMode = 'quick-open' | 'name-filter'

export function prepareQuickOpenFiles(files: readonly string[]): QuickOpenIndexedFile[] {
  return files.map((path, inputIndex) => prepareQuickOpenFile(path, inputIndex))
}

const identifierBoundaries = new WeakMap<QuickOpenIndexedFile, ReadonlySet<number>>()

const preparedQuickOpenFiles = new WeakMap<readonly string[], QuickOpenIndexedFile[]>()

export function getPreparedQuickOpenFiles(
  files: readonly string[]
): readonly QuickOpenIndexedFile[] {
  const cached = preparedQuickOpenFiles.get(files)
  if (cached) {
    return cached
  }
  const prepared = prepareQuickOpenFiles(files)
  preparedQuickOpenFiles.set(files, prepared)
  return prepared
}

export function rankQuickOpenFiles(
  query: string,
  files: readonly QuickOpenIndexedFile[],
  limit = QUICK_OPEN_RESULT_LIMIT
): QuickOpenSearchResult[] {
  if (limit <= 0 || isQuickOpenQueryTooLarge(query)) {
    return []
  }

  const normalizedQuery = normalizeQuickOpenQuery(query)
  const results: QuickOpenRankedResult[] = []
  for (const file of files) {
    const score = scoreQuickOpenTerms(normalizedQuery, file)
    if (score !== null) {
      retainTopResult(results, { path: file.path, score, inputIndex: file.inputIndex }, limit)
    }
  }
  return finalizeResults(results)
}

export class QuickOpenPathRanker {
  private readonly normalizedQuery: readonly string[] | null
  private readonly retained: QuickOpenRankedResult[] = []
  private inputIndex = 0
  private matchCount = 0

  constructor(
    query: string,
    private readonly limit: number
  ) {
    this.normalizedQuery =
      limit <= 0 || isQuickOpenQueryTooLarge(query) ? null : normalizeQuickOpenQuery(query)
  }

  consider(path: string): void {
    const file = prepareQuickOpenFile(path, this.inputIndex++)
    if (this.normalizedQuery === null) {
      return
    }
    const score = scoreQuickOpenTerms(this.normalizedQuery, file)
    if (score === null) {
      return
    }
    this.matchCount++
    retainTopResult(
      this.retained,
      { path: file.path, score, inputIndex: file.inputIndex },
      this.limit
    )
  }

  result(): { paths: string[]; totalCount: number } {
    return {
      paths: finalizeResults(this.retained).map((result) => result.path),
      totalCount: this.matchCount
    }
  }
}

function normalizeQuickOpenQuery(query: string): readonly string[] {
  const terms = [...new Set(query.trim().replace(/\\/g, '/').toLowerCase().split(/\s+/))]
    .filter(Boolean)
    .sort()
  return terms
}

function scoreQuickOpenTerms(terms: readonly string[], file: QuickOpenIndexedFile): number | null {
  let score = 0
  for (const term of terms) {
    let termScore = fuzzyMatchIndexedFile(term, file)
    if (termScore === null && (term.includes('-') || term.includes('_'))) {
      const filenameStart = file.lowerPath.lastIndexOf('/') + 1
      const parentStart = file.lowerPath.lastIndexOf('/', filenameStart - 2) + 1
      const fallback =
        fuzzyMatchIndexedFile(term, file, true) ??
        fuzzyMatchIndexedFile(term, file, true, filenameStart) ??
        fuzzyMatchIndexedFile(term, file, true, parentStart) ??
        (fuzzyMatchIndexedFile(term.replace(/[-_]/g, ''), file) === null
          ? null
          : matchQuickOpenSeparatorAlternatives(
              term,
              file.lowerPath,
              identifierBoundaries.get(file)
            ))
      termScore = fallback === null ? null : fallback + 10
    }
    if (termScore === null) {
      return null
    }
    score += termScore
  }
  return score
}

function prepareQuickOpenFile(path: string, inputIndex: number): QuickOpenIndexedFile {
  const searchPath = path.replace(/\\/g, '/')
  const lastSlash = searchPath.lastIndexOf('/')
  const file = {
    path,
    lowerPath: searchPath.toLowerCase(),
    lowerFilename: searchPath.slice(lastSlash + 1).toLowerCase(),
    inputIndex
  }
  if (/[A-Z]/.test(searchPath)) {
    const boundaries = new Set<number>()
    let lowerOffset = 0
    for (let index = 0; index < searchPath.length; index++) {
      if (
        index > 0 &&
        /[A-Z]/.test(searchPath[index]) &&
        (/[a-z0-9]/.test(searchPath[index - 1]) ||
          (/[A-Z]/.test(searchPath[index - 1]) && /[a-z]/.test(searchPath[index + 1] ?? '')))
      ) {
        boundaries.add(lowerOffset)
      }
      lowerOffset += searchPath[index].toLowerCase().length
    }
    if (boundaries.size > 0) {
      identifierBoundaries.set(file, boundaries)
    }
  }
  return file
}

function fuzzyMatchIndexedFile(
  query: string,
  file: QuickOpenIndexedFile,
  equivalentSeparators = false,
  searchStart = 0
): number | null {
  let qi = 0
  let score = 0
  let lastMatchIdx = -1

  while (qi < query.length) {
    const next = lastMatchIdx === -1 ? searchStart : lastMatchIdx + 1
    let ti = file.lowerPath[next] === query[qi] ? next : file.lowerPath.indexOf(query[qi], next + 1)
    if (equivalentSeparators && (query[qi] === '-' || query[qi] === '_')) {
      for (const separator of ['-', '_', ' ']) {
        const alternate = file.lowerPath.indexOf(separator, next)
        if (alternate !== -1 && (ti === -1 || alternate < ti)) {
          ti = alternate
        }
      }
      if (lastMatchIdx >= 0 && ti !== next && identifierBoundaries.get(file)?.has(next)) {
        score += 2
        qi++
        continue
      }
    }
    if (ti === -1) {
      return null
    }
    const gap = lastMatchIdx === -1 ? 0 : ti - lastMatchIdx - 1
    score += gap
    if (
      ti > 0 &&
      (file.lowerPath[ti - 1] === '/' ||
        file.lowerPath[ti - 1] === '.' ||
        file.lowerPath[ti - 1] === '-' ||
        (equivalentSeparators && file.lowerPath[ti - 1] === '_'))
    ) {
      score -= 5
    }
    lastMatchIdx = ti
    qi++
  }

  if (qi < query.length) {
    return null
  }
  if (
    equivalentSeparators
      ? filenameContainsSeparatorVariant(file.lowerFilename, query) ||
        file.lowerFilename.includes(query.replace(/[-_]/g, ''))
      : file.lowerFilename.includes(query)
  ) {
    score -= 100
  }
  return score
}

function filenameContainsSeparatorVariant(filename: string, query: string): boolean {
  for (let start = 0; start <= filename.length - query.length; start++) {
    let offset = 0
    while (offset < query.length) {
      const expected = query[offset]
      const actual = filename[start + offset]
      if (
        expected !== actual &&
        !(
          (expected === '-' || expected === '_') &&
          (actual === '-' || actual === '_' || actual === ' ')
        )
      ) {
        break
      }
      offset++
    }
    if (offset === query.length) {
      return true
    }
  }
  return false
}
