import { sep } from 'node:path'
import type { Store } from '../persistence'
import { fileListingCancellationError } from '../../shared/file-listing-cancellation'
import { buildExcludePathPrefixes, buildRgArgsForQuickOpen } from '../../shared/quick-open-filter'
import {
  isQuickOpenQueryTooLarge,
  NameFilterPathMatcher,
  QuickOpenPathRanker,
  type PathSearchMatcher,
  type PathSearchMode
} from '../../shared/quick-open-path-search'
import {
  RipgrepLaunchFailureError,
  RipgrepUnavailableError
} from '../../shared/ripgrep-process-availability'
import { parseWslPath } from '../wsl'
import { checkRgAvailable } from './rg-availability'
import { resolveAuthorizedPath } from './filesystem-auth'
import { getLocalGitOptionsForRegisteredWorktree } from './local-worktree-runtime-options'
import { buildRipgrepRequiredMessage } from '../../shared/quick-open-install-rg'
import { scanRipgrepPaths } from './quick-open-rg-path-scan'

export type QuickOpenFilePathSearchResult = {
  paths: string[]
  totalCount: number
  truncated: boolean
}

export async function searchQuickOpenFilePaths(
  rootPath: string,
  store: Store,
  args: {
    query: string
    limit: number
    excludePaths?: string[]
    signal?: AbortSignal
    /** Defaults to `quick-open` so the runtime RPC path keeps its ranking behavior. */
    mode?: PathSearchMode
    /**
     * Defaults to true (the full listing's scope, gitignored files included). False restricts
     * the scan to the Contents-tab scope and skips the usually much larger ignored tree.
     */
    includeIgnoredFiles?: boolean
  }
): Promise<QuickOpenFilePathSearchResult> {
  if (args.limit <= 0 || !args.query.trim() || isQuickOpenQueryTooLarge(args.query)) {
    return { paths: [], totalCount: 0, truncated: false }
  }
  const authorizedRootPath = await resolveAuthorizedPath(rootPath, store)
  const localGitOptions = getLocalGitOptionsForRegisteredWorktree(
    store,
    rootPath,
    authorizedRootPath
  )
  const wslDistroForOutput = parseWslPath(authorizedRootPath)?.distro ?? localGitOptions.wslDistro

  const fallback = async (): Promise<QuickOpenFilePathSearchResult> => {
    throw new Error(await buildRipgrepRequiredMessage())
  }
  const excludePathPrefixes = buildExcludePathPrefixes(authorizedRootPath, args.excludePaths)
  const { primary, ignoredPass } = buildRgArgsForQuickOpen({
    searchRoot: '.',
    excludePathPrefixes,
    forceSlashSeparator: sep === '\\'
  })
  const passArgs = args.includeIgnoredFiles === false ? primary : ignoredPass
  // Fresh ranker per attempt so a retry cannot double-count paths from the aborted scan.
  const scanOnce = async (): Promise<QuickOpenFilePathSearchResult> => {
    const matcher = createPathSearchMatcher(args.mode, args.query, args.limit)
    await scanRipgrepPaths({
      args: passArgs,
      authorizedRootPath,
      excludePathPrefixes,
      localGitOptions,
      onPath: (path) => {
        matcher.consider(path)
        return true
      },
      signal: args.signal,
      wslDistroForOutput
    })
    const result = matcher.result()
    return { ...result, truncated: result.totalCount > args.limit }
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (
        wslDistroForOutput &&
        !(await checkRgAvailable(authorizedRootPath, localGitOptions.wslDistro, {
          rejectTransientLaunchFailure: true
        }))
      ) {
        return fallback()
      }
      return await scanOnce()
    } catch (error) {
      if (error instanceof RipgrepUnavailableError) {
        return fallback()
      }
      // Why: a supersede that lands after the scan rejected still owes the caller a cancellation.
      if (args.signal?.aborted) {
        throw fileListingCancellationError(args.signal)
      }
      // Why: one-off fork/exec pressure should not blank Quick Open until the query changes.
      if (!(error instanceof RipgrepLaunchFailureError) || attempt > 0) {
        throw error
      }
    }
  }
  throw new Error('unreachable Quick Open retry state')
}

// Why: one ripgrep pass covers both matchers — every line is counted, only the page is kept.
function createPathSearchMatcher(
  mode: PathSearchMode | undefined,
  query: string,
  limit: number
): PathSearchMatcher {
  return mode === 'name-filter'
    ? new NameFilterPathMatcher(query, limit)
    : new QuickOpenPathRanker(query, limit)
}

export type QuickOpenPathCollection = {
  paths: string[]
  authorizedRootPath: string
  /** True when the walk hit `maxPaths`; the caller must not treat `paths` as complete. */
  budgetExceeded: boolean
}

/**
 * One ripgrep pass over the workspace with no matcher, for the host-side path inventory.
 * `included` respects `.gitignore` (the Contents-tab scope); `all` is the `--no-ignore-vcs`
 * superset the listing uses when it is showing gitignored files.
 */
export async function collectQuickOpenPaths(
  rootPath: string,
  store: Store,
  args: {
    pass: 'included' | 'all'
    excludePaths?: string[]
    signal?: AbortSignal
    maxPaths?: number
  }
): Promise<QuickOpenPathCollection> {
  const authorizedRootPath = await resolveAuthorizedPath(rootPath, store)
  const localGitOptions = getLocalGitOptionsForRegisteredWorktree(
    store,
    rootPath,
    authorizedRootPath
  )
  const wslDistroForOutput = parseWslPath(authorizedRootPath)?.distro ?? localGitOptions.wslDistro
  if (
    wslDistroForOutput &&
    !(await checkRgAvailable(authorizedRootPath, localGitOptions.wslDistro, {
      rejectTransientLaunchFailure: true
    }))
  ) {
    throw new Error(await buildRipgrepRequiredMessage())
  }
  const excludePathPrefixes = buildExcludePathPrefixes(authorizedRootPath, args.excludePaths)
  const { primary, ignoredPass } = buildRgArgsForQuickOpen({
    searchRoot: '.',
    excludePathPrefixes,
    forceSlashSeparator: sep === '\\'
  })
  const maxPaths = args.maxPaths ?? Number.POSITIVE_INFINITY
  const paths: string[] = []
  let budgetExceeded = false
  await scanRipgrepPaths({
    args: args.pass === 'included' ? primary : ignoredPass,
    authorizedRootPath,
    excludePathPrefixes,
    localGitOptions,
    onPath: (path) => {
      if (paths.length >= maxPaths) {
        budgetExceeded = true
        return false
      }
      paths.push(path)
      return true
    },
    signal: args.signal,
    wslDistroForOutput
  })
  return { paths, authorizedRootPath, budgetExceeded }
}
