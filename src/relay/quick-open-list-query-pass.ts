import { NameFilterPathMatcher, QuickOpenPathRanker } from '../shared/quick-open-path-search'
import type { PathSearchMatcher } from '../shared/quick-open-path-search'

/**
 * Query-scoped options a listing pass honors. An unscoped browse listing omits all of them and
 * keeps rg's own order; a name filter keeps every whitespace-separated token, dotfiles optional.
 */
export type QuickOpenListQueryOptions = {
  searchQuery?: string
  searchMode?: 'quick-open' | 'name-filter'
  includeIgnoredFiles?: boolean
  includeDotfiles?: boolean
  onSearchResult?: (result: { paths: string[]; totalCount: number }, complete: boolean) => void
}

/** Picks the matcher a listing pass ranks candidates with; null keeps the plain listing order. */
export function createQuickOpenListMatcher(args: {
  searchQuery: string | undefined
  searchMode: 'quick-open' | 'name-filter' | undefined
  maxResults: number | undefined
}): PathSearchMatcher | null {
  if (args.searchQuery === undefined) {
    return null
  }
  return args.searchMode === 'name-filter'
    ? new NameFilterPathMatcher(args.searchQuery, args.maxResults ?? 16)
    : new QuickOpenPathRanker(args.searchQuery, args.maxResults ?? 16)
}
