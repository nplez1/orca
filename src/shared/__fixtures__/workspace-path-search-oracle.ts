import { Buffer } from 'node:buffer'
import { performance } from 'node:perf_hooks'
import { resolve } from 'node:path'
import type {
  WorkspacePathSearchPageBudget,
  WorkspacePathSearchScopeDescriptor
} from '../workspace-path-search-contract'
import type {
  WorkspacePathSearchCorrelationId,
  WorkspacePathSearchInstrumentationEvent
} from '../workspace-path-search-instrumentation'
import {
  buildExcludePathPrefixes,
  shouldExcludeQuickOpenRelPath,
  shouldIncludeQuickOpenPath
} from '../quick-open-filter'
import {
  isQuickOpenQueryTooLarge,
  NameFilterPathMatcher,
  pathMatchesQueryTokens,
  splitPathQueryTokens
} from '../quick-open-path-search'
import { compareFileNames } from '../file-name-sort'

export const WORKSPACE_PATH_SEARCH_ORACLE_MAX_PAGE_PATHS = 5_000

export type WorkspacePathSearchOracleScope = Pick<
  WorkspacePathSearchScopeDescriptor,
  'includeDotfiles' | 'includeIgnoredFiles'
> & {
  rootPath: string
  excludePaths: readonly string[]
  ignoredPaths: ReadonlySet<string>
}

export type WorkspacePathSearchOracleOptions = {
  scope?: Partial<WorkspacePathSearchOracleScope>
  pageBudget?: Partial<WorkspacePathSearchPageBudget>
  correlationId?: WorkspacePathSearchCorrelationId
  generationId?: string | null
  onInstrumentation?: (event: WorkspacePathSearchInstrumentationEvent) => void
}

export type WorkspacePathSearchPage = {
  paths: string[]
  totalCount: number
}

export type WorkspacePathSearchOracleResult = WorkspacePathSearchPage & {
  serializedPageBytes: number
}

const DEFAULT_ROOT_PATH = resolve(process.cwd(), 'workspace-path-search-fixture-root')

/**
 * Deliberately scans the complete snapshot, then sorts every eligible match before retaining a
 * count- and byte-bounded prefix. Keep this implementation simple as the future engine oracle.
 */
export function runWorkspacePathSearchOracle(
  snapshot: Iterable<string>,
  query: string,
  options: WorkspacePathSearchOracleOptions = {}
): WorkspacePathSearchOracleResult {
  const startedAt = performance.now()
  const scope: WorkspacePathSearchOracleScope = {
    includeDotfiles: options.scope?.includeDotfiles ?? true,
    includeIgnoredFiles: options.scope?.includeIgnoredFiles ?? true,
    rootPath: options.scope?.rootPath ?? DEFAULT_ROOT_PATH,
    excludePaths: options.scope?.excludePaths ?? [],
    ignoredPaths: options.scope?.ignoredPaths ?? new Set<string>()
  }
  const maxPaths = boundedPagePathCount(options.pageBudget?.maxPaths)
  const maxSerializedBytes = options.pageBudget?.maxSerializedBytes ?? Number.POSITIVE_INFINITY
  const matches: string[] = []
  const queryIsTooLarge = isQuickOpenQueryTooLarge(query)
  const tokens = queryIsTooLarge ? [] : splitPathQueryTokens(query)
  let pathsConsidered = 0
  let eligibleCandidates = 0

  if (maxPaths > 0 && !queryIsTooLarge && tokens.length > 0) {
    const excludedPrefixes = buildExcludePathPrefixes(scope.rootPath, [...scope.excludePaths])
    for (const path of snapshot) {
      pathsConsidered += 1
      if (!isPathInWorkspaceSearchScope(path, scope, excludedPrefixes)) {
        continue
      }
      eligibleCandidates += 1
      if (pathMatchesQueryTokens(path, tokens)) {
        matches.push(path)
      }
    }
  }

  matches.sort(compareFileNames)
  const paths: string[] = []
  const emptyPageBytes = Buffer.byteLength(
    JSON.stringify({ paths, totalCount: matches.length }),
    'utf8'
  )
  let encodedPathEntriesBytes = 0
  for (const path of matches) {
    if (paths.length >= maxPaths) {
      break
    }
    const nextPathEntriesBytes =
      encodedPathEntriesBytes +
      Buffer.byteLength(JSON.stringify(path), 'utf8') +
      (paths.length > 0 ? 1 : 0)
    if (emptyPageBytes + nextPathEntriesBytes > maxSerializedBytes) {
      break
    }
    paths.push(path)
    encodedPathEntriesBytes = nextPathEntriesBytes
  }

  const serializedPageBytes = Buffer.byteLength(
    JSON.stringify({ paths, totalCount: matches.length }),
    'utf8'
  )
  const correlationId = options.correlationId ?? 'workspace-path-oracle'
  options.onInstrumentation?.({
    kind: 'stage-timing',
    record: {
      correlationId,
      stage: 'query-strategy',
      duration: {
        milliseconds: performance.now() - startedAt,
        clock: 'execution-host-monotonic'
      }
    }
  })
  options.onInstrumentation?.({
    kind: 'query-metrics',
    record: {
      correlationId,
      generationId: options.generationId ?? null,
      strategy: 'ordered-scan',
      pathsConsidered,
      candidates: eligibleCandidates,
      verifications: eligibleCandidates,
      exactMatches: matches.length,
      retained: paths.length,
      serializedBytes: serializedPageBytes
    }
  })

  return { paths, totalCount: matches.length, serializedPageBytes }
}

/** Runs the existing streaming matcher over the same eligible snapshot for oracle self-checks. */
export function runNameFilterPathMatcher(
  snapshot: Iterable<string>,
  query: string,
  options: WorkspacePathSearchOracleOptions = {}
): WorkspacePathSearchPage {
  const scope: WorkspacePathSearchOracleScope = {
    includeDotfiles: options.scope?.includeDotfiles ?? true,
    includeIgnoredFiles: options.scope?.includeIgnoredFiles ?? true,
    rootPath: options.scope?.rootPath ?? DEFAULT_ROOT_PATH,
    excludePaths: options.scope?.excludePaths ?? [],
    ignoredPaths: options.scope?.ignoredPaths ?? new Set<string>()
  }
  const excludedPrefixes = buildExcludePathPrefixes(scope.rootPath, [...scope.excludePaths])
  const limit = boundedPagePathCount(options.pageBudget?.maxPaths)
  const matcher = new NameFilterPathMatcher(query, limit)
  if (limit === 0 || isQuickOpenQueryTooLarge(query) || splitPathQueryTokens(query).length === 0) {
    return matcher.result()
  }
  for (const path of snapshot) {
    if (isPathInWorkspaceSearchScope(path, scope, excludedPrefixes)) {
      matcher.consider(path)
    }
  }
  return matcher.result()
}

export function findWorkspacePathSearchDifferences(
  expected: WorkspacePathSearchPage,
  actual: WorkspacePathSearchPage
): string[] {
  const differences: string[] = []
  if (expected.totalCount !== actual.totalCount) {
    differences.push(`totalCount: expected ${expected.totalCount}, received ${actual.totalCount}`)
  }
  if (expected.paths.length !== actual.paths.length) {
    differences.push(
      `page length: expected ${expected.paths.length}, received ${actual.paths.length}`
    )
  }
  const sharedLength = Math.min(expected.paths.length, actual.paths.length)
  for (let index = 0; index < sharedLength; index += 1) {
    const expectedPath = expected.paths[index]!
    const actualPath = actual.paths[index]!
    if (expectedPath !== actualPath) {
      differences.push(
        `page[${index}]: expected ${JSON.stringify(expectedPath)}, received ${JSON.stringify(actualPath)}`
      )
      if (differences.length >= 8) {
        break
      }
    }
  }
  return differences
}

export function assertWorkspacePathSearchEquivalent(
  query: string,
  expected: WorkspacePathSearchPage,
  actual: WorkspacePathSearchPage
): void {
  const differences = findWorkspacePathSearchDifferences(expected, actual)
  if (differences.length > 0) {
    throw new Error(
      `Workspace path-search mismatch for ${JSON.stringify(query)}:\n${differences.join('\n')}`
    )
  }
}

function isPathInWorkspaceSearchScope(
  path: string,
  scope: WorkspacePathSearchOracleScope,
  excludedPrefixes: readonly string[]
): boolean {
  return (
    shouldIncludeQuickOpenPath(path) &&
    !shouldExcludeQuickOpenRelPath(path, excludedPrefixes) &&
    (scope.includeDotfiles || !isDotfileRelativePath(path)) &&
    (scope.includeIgnoredFiles || !scope.ignoredPaths.has(path))
  )
}

function isDotfileRelativePath(path: string): boolean {
  return path
    .split(/[\\/]+/)
    .some((segment) => segment.length > 1 && segment !== '..' && segment.startsWith('.'))
}

function boundedPagePathCount(requestedCount: number | undefined): number {
  if (requestedCount === undefined) {
    return WORKSPACE_PATH_SEARCH_ORACLE_MAX_PAGE_PATHS
  }
  if (!Number.isFinite(requestedCount) || requestedCount <= 0) {
    return 0
  }
  return Math.min(WORKSPACE_PATH_SEARCH_ORACLE_MAX_PAGE_PATHS, Math.floor(requestedCount))
}
