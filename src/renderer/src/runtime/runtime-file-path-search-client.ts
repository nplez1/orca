import type { FilePathSearchResult } from '../../../shared/file-path-search-result'
import type { PathSearchMode } from '../../../shared/quick-open-path-search'
import type { WorkspacePathSearchCorrelationId } from '../../../shared/workspace-path-search-instrumentation'
import { validateWorkspacePathSearchQuery } from '../../../shared/workspace-path-search-contract'
import type { RuntimeFileListResult } from '../../../shared/runtime-types'
import {
  buildExcludePathPrefixes,
  shouldExcludeQuickOpenRelPath
} from '../../../shared/quick-open-filter'
import type { RuntimeFileOperationArgs } from './runtime-file-client-types'
import {
  hasCachedLegacyQuickOpenInventory,
  searchLegacyQuickOpenInventory
} from './runtime-legacy-quick-open-inventory'
import { callRuntimeRpc, getActiveRuntimeTarget, RuntimeRpcCallError } from './runtime-rpc-client'
import { searchRuntimeNameFilterPaths } from './runtime-workspace-path-search-client'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'

const QUICK_OPEN_REMOTE_UPDATE_REQUIRED_MESSAGE =
  'Quick Open search requires a newer paired Orca host. Update the remote host and reconnect.'

/**
 * The Quick Open entry point: a local workspace and a remote host both answer the same
 * query-scoped request, so this picks the transport and keeps the version gates that decide
 * when a host is too old to answer at all.
 */
export async function searchRuntimeFilePaths(
  context: RuntimeFileOperationArgs,
  args: {
    query: string
    limit?: number
    includeIgnored?: boolean
    allowLegacyIncludeIgnored?: boolean
    followSymlinks?: boolean
    excludePaths?: string[]
    requestToken?: string
    signal?: AbortSignal
    mode?: PathSearchMode
    includeIgnoredFiles?: boolean
    includeDotfiles?: boolean
    correlationId?: WorkspacePathSearchCorrelationId
  }
): Promise<FilePathSearchResult> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind !== 'environment') {
    if (!context.worktreePath) {
      return { files: [], totalCount: null, truncated: false }
    }
    const limit = args.limit ?? 32
    // Why: a local workspace has the same query-scoped search as a remote host, and only it
    // can count matches past the page — an unscoped listing cannot.
    if (!context.connectionId) {
      return window.api.fs.searchFilePaths({
        rootPath: context.worktreePath,
        query: args.query,
        limit,
        mode: args.mode,
        excludePaths: args.excludePaths,
        includeIgnoredFiles: args.includeIgnoredFiles,
        requestToken: args.requestToken,
        ...(args.correlationId === undefined ? {} : { correlationId: args.correlationId })
      })
    }
    if (args.mode === 'name-filter') {
      const validated = validateWorkspacePathSearchQuery(args.query, 'remote')
      if (!validated.ok || !validated.query.trim()) {
        throw new Error('Remote filename filter query is too large or invalid')
      }
      return window.api.fs.searchFilePaths({
        rootPath: context.worktreePath,
        connectionId: context.connectionId,
        query: validated.query,
        limit,
        mode: 'name-filter',
        excludePaths: args.excludePaths,
        includeIgnoredFiles: args.includeIgnoredFiles,
        includeDotfiles: args.includeDotfiles,
        requestToken: args.requestToken,
        correlationId: args.correlationId
      })
    }
    const files = await window.api.fs.listFiles({
      rootPath: context.worktreePath,
      connectionId: context.connectionId,
      excludePaths: args.excludePaths,
      requestToken: args.requestToken,
      maxResults: limit + 1,
      ...(args.includeIgnored === undefined ? {} : { includeIgnored: args.includeIgnored }),
      ...(args.followSymlinks === undefined ? {} : { followSymlinks: args.followSymlinks }),
      ...(args.allowLegacyIncludeIgnored ? { allowLegacyIncludeIgnored: true } : {}),
      searchQuery: args.query
    })
    return { files: files.slice(0, limit), totalCount: null, truncated: files.length > limit }
  }
  if (!context.worktreeId) {
    return { files: [], totalCount: null, truncated: false }
  }
  const worktreeSelector = toRuntimeWorktreeSelector(context.worktreeId)
  const limit = args.limit ?? 32
  if (args.mode === 'name-filter') {
    return searchRuntimeNameFilterPaths(context, target, {
      query: args.query,
      limit,
      excludePaths: args.excludePaths,
      signal: args.signal,
      includeIgnoredFiles: args.includeIgnoredFiles,
      includeDotfiles: args.includeDotfiles,
      correlationId: args.correlationId
    })
  }
  const searchLegacy = () =>
    searchLegacyQuickOpenInventory({
      target,
      worktreeSelector,
      query: args.query,
      limit,
      worktreePath: context.worktreePath,
      excludePaths: args.excludePaths,
      signal: args.signal
    })
  const searchLegacyOrRequireUpdate = async () => {
    try {
      return await searchLegacy()
    } catch (error) {
      if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
        throw new Error(QUICK_OPEN_REMOTE_UPDATE_REQUIRED_MESSAGE)
      }
      throw error
    }
  }
  if (
    args.includeIgnored !== false &&
    !args.followSymlinks &&
    hasCachedLegacyQuickOpenInventory(target, worktreeSelector, context.worktreePath)
  ) {
    return searchLegacy()
  }
  let result: RuntimeFileListResult
  try {
    result = await callRuntimeRpc<RuntimeFileListResult>(
      target,
      'files.searchPaths',
      {
        worktree: worktreeSelector,
        query: args.query,
        limit,
        excludePaths: args.excludePaths,
        ...(args.includeIgnored === undefined ? {} : { includeIgnored: args.includeIgnored }),
        ...(args.followSymlinks === undefined ? {} : { followSymlinks: args.followSymlinks }),
        ...(args.allowLegacyIncludeIgnored ? { allowLegacyIncludeIgnored: true } : {}),
        mode: 'quick-open'
      },
      { timeoutMs: 15_000, ...(args.signal === undefined ? {} : { signal: args.signal }) }
    )
  } catch (error) {
    if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
      if (
        (args.includeIgnored === false && !args.allowLegacyIncludeIgnored) ||
        args.followSymlinks
      ) {
        throw new Error('Update the remote host to use Quick Open listing options.')
      }
      return searchLegacyOrRequireUpdate()
    }
    throw error
  }
  if (
    ((args.includeIgnored === false && !args.allowLegacyIncludeIgnored) || args.followSymlinks) &&
    (result.quickOpenSearchVersion ?? 0) < 2
  ) {
    throw new Error('Update the remote host to use Quick Open listing options.')
  }
  if (args.excludePaths?.length && (result.quickOpenSearchVersion ?? 0) < 1) {
    return searchLegacyOrRequireUpdate()
  }
  const excludePrefixes = buildExcludePathPrefixes(
    context.worktreePath ?? result.rootPath,
    args.excludePaths
  )
  return {
    files: result.files
      .map((entry) => entry.relativePath)
      .filter((relativePath) => !shouldExcludeQuickOpenRelPath(relativePath, excludePrefixes)),
    totalCount: result.totalCount ?? null,
    truncated: result.truncated
  }
}
