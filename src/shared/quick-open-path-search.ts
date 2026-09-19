import { isClipboardTextByteLengthOverLimit } from './clipboard-text'
import { compareFileNames } from './file-name-sort'

export const QUICK_OPEN_RESULT_LIMIT = 50
export const QUICK_OPEN_QUERY_MAX_BYTES = 2 * 1024
export const QUICK_OPEN_REMOTE_QUERY_MAX_CODE_UNITS = 256
export const QUICK_OPEN_SEARCH_VERSION = 1

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

export function isQuickOpenQueryTooLarge(
  query: string,
  maxBytes = QUICK_OPEN_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}

export function isQuickOpenRemoteQueryTooLarge(query: string): boolean {
  return query.length > QUICK_OPEN_REMOTE_QUERY_MAX_CODE_UNITS || isQuickOpenQueryTooLarge(query)
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
    const score = normalizedQuery ? fuzzyMatchIndexedFile(normalizedQuery, file) : 0
    if (score !== -1) {
      retainTopResult(results, { path: file.path, score, inputIndex: file.inputIndex }, limit)
    }
  }
  return finalizeResults(results)
}

export class QuickOpenPathRanker {
  private readonly normalizedQuery: string | null
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
    const score = this.normalizedQuery ? fuzzyMatchIndexedFile(this.normalizedQuery, file) : 0
    if (score === -1) {
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

function normalizeQuickOpenQuery(query: string): string {
  return query.trim().replace(/\\/g, '/').toLowerCase()
}

/**
 * Whitespace-separated, lowercased tokens. The host scan and the renderer's
 * `relativePathMatchesNameFilter` share this so a filtered page and its client-side
 * re-check agree on what matches.
 * Why: accepted pasted queries are on a hot path; tokenize whitespace directly instead of
 * allocating a regex split array.
 */
export function splitPathQueryTokens(query: string): string[] {
  const tokens: string[] = []
  let tokenStart = -1
  for (let index = 0; index <= query.length; index += 1) {
    const isEnd = index === query.length
    if (!isEnd && !isQueryWhitespace(query.charCodeAt(index))) {
      if (tokenStart === -1) {
        tokenStart = index
      }
      continue
    }
    if (tokenStart !== -1) {
      tokens.push(query.slice(tokenStart, index).toLocaleLowerCase())
      tokenStart = -1
    }
  }
  return tokens
}

function isQueryWhitespace(code: number): boolean {
  return (
    code === 32 ||
    (code >= 9 && code <= 13) ||
    code === 160 ||
    code === 5760 ||
    (code >= 8192 && code <= 8202) ||
    code === 8232 ||
    code === 8233 ||
    code === 8239 ||
    code === 8287 ||
    code === 12288 ||
    code === 65279
  )
}

/** Every token must appear somewhere in the lowercased relative path. */
export function pathMatchesQueryTokens(relativePath: string, tokens: readonly string[]): boolean {
  if (tokens.length === 0) {
    return true
  }
  // Why: callers pass already-normalized paths — lowercasing only, no second normalize per path.
  const haystack = relativePath.toLocaleLowerCase()
  return tokens.every((token) => haystack.includes(token))
}

/**
 * Substring-AND matcher for the Explore name filter. Counts every match and retains only the
 * lexicographically first `limit` paths, so host memory cannot grow with the workspace and the
 * page is a stable prefix of the order the tree renders in. `totalCount` is exact, and callers
 * surface it so a bounded page never reads as a complete result set.
 */
export class NameFilterPathMatcher {
  private readonly tokens: string[]
  private readonly retained: QuickOpenRankedResult[] = []
  private inputIndex = 0
  private matchCount = 0

  constructor(
    query: string,
    private readonly limit: number
  ) {
    this.tokens = limit <= 0 || isQuickOpenQueryTooLarge(query) ? [] : splitPathQueryTokens(query)
  }

  consider(path: string): void {
    const inputIndex = this.inputIndex++
    if (this.tokens.length === 0 || !pathMatchesQueryTokens(path, this.tokens)) {
      return
    }
    this.matchCount++
    // Why: score 0 for every match makes retainTopResult a bounded max-heap on the path,
    // so the retained page is the first `limit` names in sort order, not in scan order.
    retainTopResult(this.retained, { path, score: 0, inputIndex }, this.limit)
  }

  result(): { paths: string[]; totalCount: number } {
    return {
      paths: this.retained.sort(compareRankedResult).map((entry) => entry.path),
      totalCount: this.matchCount
    }
  }
}

function prepareQuickOpenFile(path: string, inputIndex: number): QuickOpenIndexedFile {
  const searchPath = path.replace(/\\/g, '/')
  const lastSlash = searchPath.lastIndexOf('/')
  return {
    path,
    lowerPath: searchPath.toLowerCase(),
    lowerFilename: searchPath.slice(lastSlash + 1).toLowerCase(),
    inputIndex
  }
}

function fuzzyMatchIndexedFile(query: string, file: QuickOpenIndexedFile): number {
  let qi = 0
  let score = 0
  let lastMatchIdx = -1

  while (qi < query.length) {
    const next = lastMatchIdx + 1
    const ti =
      file.lowerPath[next] === query[qi] ? next : file.lowerPath.indexOf(query[qi], next + 1)
    if (ti === -1) {
      return -1
    }
    const gap = lastMatchIdx === -1 ? 0 : ti - lastMatchIdx - 1
    score += gap
    if (
      ti > 0 &&
      (file.lowerPath[ti - 1] === '/' ||
        file.lowerPath[ti - 1] === '.' ||
        file.lowerPath[ti - 1] === '-')
    ) {
      score -= 5
    }
    lastMatchIdx = ti
    qi++
  }

  if (qi < query.length) {
    return -1
  }
  if (file.lowerFilename.includes(query)) {
    score -= 100
  }
  return score
}

type QuickOpenRankedResult = QuickOpenSearchResult & {
  inputIndex: number
}

function retainTopResult(
  heap: QuickOpenRankedResult[],
  candidate: QuickOpenRankedResult,
  limit: number
): void {
  if (heap.length === limit && compareRankedResult(candidate, heap[0]) >= 0) {
    return
  }
  if (heap.length < limit) {
    heap.push(candidate)
    siftResultUp(heap, heap.length - 1)
    return
  }
  heap[0] = candidate
  siftResultDown(heap)
}

function siftResultUp(heap: QuickOpenRankedResult[], startIndex: number): void {
  let index = startIndex
  while (index > 0) {
    const parentIndex = Math.floor((index - 1) / 2)
    if (compareRankedResult(heap[index], heap[parentIndex]) <= 0) {
      return
    }
    ;[heap[index], heap[parentIndex]] = [heap[parentIndex], heap[index]]
    index = parentIndex
  }
}

function siftResultDown(heap: QuickOpenRankedResult[]): void {
  let index = 0
  while (true) {
    const leftIndex = index * 2 + 1
    if (leftIndex >= heap.length) {
      return
    }
    const rightIndex = leftIndex + 1
    const worseChildIndex =
      rightIndex < heap.length && compareRankedResult(heap[rightIndex], heap[leftIndex]) > 0
        ? rightIndex
        : leftIndex
    if (compareRankedResult(heap[worseChildIndex], heap[index]) <= 0) {
      return
    }
    ;[heap[index], heap[worseChildIndex]] = [heap[worseChildIndex], heap[index]]
    index = worseChildIndex
  }
}

function finalizeResults(results: QuickOpenRankedResult[]): QuickOpenSearchResult[] {
  return results
    .sort(compareRankedResult)
    .map(({ path, score }): QuickOpenSearchResult => ({ path, score }))
}

function compareRankedResult(a: QuickOpenRankedResult, b: QuickOpenRankedResult): number {
  return a.score - b.score || compareFileNames(a.path, b.path) || a.inputIndex - b.inputIndex
}
