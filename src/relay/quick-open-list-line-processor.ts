import {
  normalizeQuickOpenRgLine,
  shouldExcludeQuickOpenRelPath,
  shouldIncludeQuickOpenPath
} from '../shared/quick-open-filter'
import type { PathSearchMatcher } from '../shared/quick-open-path-search'

function containsDotfileSegment(path: string): boolean {
  let start = 0
  while (start < path.length) {
    const end = path.indexOf('/', start)
    if (path.charCodeAt(start) === 46) {
      return true
    }
    start = end === -1 ? path.length : end + 1
  }
  return false
}

/** rg stdout line filter for a Quick Open listing pass; returns whether the line counted. */
export function createQuickOpenListLineProcessor(args: {
  excludePathPrefixes: readonly string[]
  searchMode: 'quick-open' | 'name-filter' | undefined
  includeDotfiles: boolean
  maxResults: number | undefined
  files: Set<string>
  onLimit: () => void
}): (rawLine: string, attemptMatcher: PathSearchMatcher | null) => boolean {
  const { excludePathPrefixes, searchMode, includeDotfiles, maxResults, files, onLimit } = args
  return (rawLine: string, attemptMatcher: PathSearchMatcher | null): boolean => {
    const relPath = normalizeQuickOpenRgLine(rawLine, { kind: 'cwd-relative' })
    if (relPath === null) {
      return false
    }
    // Why: correctness backstop. The rg globs prune most blocklisted dirs,
    // but a glob edge case could still surface e.g. a .git/ or .npm/ hit.
    if (!shouldIncludeQuickOpenPath(relPath)) {
      return true
    }
    if (shouldExcludeQuickOpenRelPath(relPath, excludePathPrefixes)) {
      return true
    }
    if (searchMode === 'name-filter' && !includeDotfiles && containsDotfileSegment(relPath)) {
      return true
    }
    if (attemptMatcher) {
      attemptMatcher.consider(relPath)
      return true
    }
    files.add(relPath)
    if (maxResults !== undefined && files.size >= maxResults) {
      onLimit()
    }
    return true
  }
}
