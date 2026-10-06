import { isQuickOpenQueryTooLarge } from './quick-open-query-size-limits'
import {
  compareRankedResult,
  retainTopResult,
  type QuickOpenRankedResult
} from './quick-open-bounded-result-page'

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
