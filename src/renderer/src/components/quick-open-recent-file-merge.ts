import { useCallback, useMemo, useRef } from 'react'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'
import type { listRuntimeFiles } from '@/runtime/runtime-file-client'
import {
  mergeQuickOpenRecentCandidates,
  useQuickOpenRecentCache
} from './quick-open-recent-validation'
import type { RuntimeFileListing } from './runtime-path-search-request'

/** The options the listing itself used, so a validated recent path is one the caller's scope would
 *  have offered anyway. */
function useRecentValidationRequest(args: {
  host: {
    runtimeEnvironmentId: string | null
    worktreeId: string | null
    worktreePath: string | null
    connectionId: string | undefined
  }
  scope: {
    excludeRequest: { paths: string[] }
    includeIgnoredFiles: boolean | undefined
    includeDotfiles: boolean
  }
}): {
  context: RuntimeFileOperationArgs
  options: Parameters<typeof listRuntimeFiles>[1]
} {
  const { connectionId, runtimeEnvironmentId, worktreeId, worktreePath } = args.host
  const { excludeRequest, includeIgnoredFiles, includeDotfiles } = args.scope
  const context = useMemo(
    () => ({
      settings: { activeRuntimeEnvironmentId: runtimeEnvironmentId },
      worktreeId: worktreeId ?? '',
      worktreePath: worktreePath ?? '',
      connectionId
    }),
    [connectionId, runtimeEnvironmentId, worktreeId, worktreePath]
  )
  const options = useMemo(
    () => ({
      rootPath: worktreePath ?? '',
      ...(excludeRequest.paths.length === 0 ? {} : { excludePaths: excludeRequest.paths }),
      ...(includeIgnoredFiles === undefined ? {} : { includeIgnoredFiles }),
      includeDotfiles
    }),
    [excludeRequest, includeDotfiles, includeIgnoredFiles, worktreePath]
  )
  return { context, options }
}

/** The recent paths a caller offered, as text only — a malformed candidate list validates nothing. */
function readRecentPaths(recentKey: string): string[] {
  const parsed: unknown = JSON.parse(recentKey)
  return Array.isArray(parsed)
    ? parsed.filter((path): path is string => typeof path === 'string')
    : []
}

/** Why: Quick Open offers recently opened paths, and one the host no longer has would otherwise be
 *  listed as a file the user can open. The validation rides the page the caller publishes — a
 *  complete inventory needs none of it, and one host request answers for every candidate — and its
 *  result is published as that same listing with the validated paths merged in.
 *  LOCAL(nplez1): re-seated from upstream's single request path onto this fork's scheduler-owned
 *  listing, which reports a bounded page and keeps one request in flight. */
export function useQuickOpenRecentListing(args: {
  enabled: boolean
  requestKey: string
  recentPaths: readonly string[] | undefined
  publish: (value: RuntimeFileListing) => void
  host: {
    runtimeEnvironmentId: string | null
    worktreeId: string | null
    worktreePath: string | null
    connectionId: string | undefined
  }
  scope: {
    excludeRequest: { paths: string[] }
    includeIgnoredFiles: boolean | undefined
    includeDotfiles: boolean
  }
}): (value: RuntimeFileListing) => void {
  const { context, options } = useRecentValidationRequest({ host: args.host, scope: args.scope })
  const recentKey = JSON.stringify(args.recentPaths ?? [])
  // Why: keyed by the request, so a new query revokes its predecessor's pending validation.
  const cache = useQuickOpenRecentCache(args.enabled, `${args.requestKey}\n${recentKey}`)
  // Why: the returned publisher is handed to the listing effects, so its identity is held stable
  // and the current request is read through a ref — that keeps the publisher out of their deps.
  const requestRef = useRef({ ...args, context, options, recentKey, cache })
  requestRef.current = { ...args, context, options, recentKey, cache }
  const publishedRef = useRef<RuntimeFileListing | null>(null)
  return useCallback((value: RuntimeFileListing) => {
    const request = requestRef.current
    publishedRef.current = value
    request.publish(value)
    const candidates = readRecentPaths(request.recentKey)
    if (!request.enabled || candidates.length === 0) {
      return
    }
    void mergeQuickOpenRecentCandidates({
      result: value,
      // Why: a complete inventory already names every path, so nothing needs validating.
      completeInventory: !value.truncated && value.query.length === 0,
      candidatePaths: candidates,
      cache: request.cache,
      key: `${request.requestKey}\n${request.recentKey}`,
      context: request.context,
      options: request.options,
      cancelled: () => publishedRef.current !== value
    }).then((next) => {
      if (next && publishedRef.current === value) {
        // Why: `mergeQuickOpenRecentCandidates` widens `result` to the page it merges into, so the
        // caller re-seats the merged paths onto the listing it published.
        request.publish({ ...value, files: next.files })
      }
    })
  }, [])
}
