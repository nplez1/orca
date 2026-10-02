import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { GitHubSlice } from './slice-types'
import type { PRComment } from '../../../../shared/github/comment-types'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'
import { prCommentsCacheSuffix, sourceScopedRepoCacheKey } from './cache-identity'
import { isFresh, withBoundedCacheEntry } from './cache-policy'
import { inflightCommentsRequests } from './request-coordination'
import { getGitHubRepoSourceSettings, getGitHubWorkItemRequestContext } from './work-item-routing'

export const createCommentFetchActions = (
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): Pick<GitHubSlice, 'fetchPRComments'> => ({
  fetchPRComments: async (repoPath, prNumber, options): Promise<PRComment[]> => {
    const repo = get().repos?.find((candidate) =>
      options?.repoId ? candidate.id === options.repoId : candidate.path === repoPath
    )
    const repoId = options?.repoId ?? repo?.id
    const requestSettings = getGitHubRepoSourceSettings(
      get().settings,
      repo,
      options?.sourceContext
    )
    const cacheKey = sourceScopedRepoCacheKey(
      repoPath,
      repoId,
      prCommentsCacheSuffix(prNumber, options?.prRepo),
      requestSettings,
      repo?.connectionId,
      repo?.executionHostId,
      options?.sourceContext,
      repo !== undefined
    )
    const cached = get().commentsCache[cacheKey]
    if (!options?.force && isFresh(cached)) {
      return cached.data ?? []
    }

    const inflightRequest = inflightCommentsRequests.get(cacheKey)
    if (inflightRequest) {
      return inflightRequest
    }

    const request = (async () => {
      try {
        const requestContext = getGitHubWorkItemRequestContext(
          get(),
          requestSettings,
          repoId ?? repoPath,
          repoPath,
          options?.sourceContext
        )
        const comments =
          requestContext.target.kind === 'environment'
            ? await callRuntimeRpc<PRComment[]>(
                { kind: 'environment', environmentId: requestContext.target.environmentId },
                'github.prComments',
                {
                  repo: requestContext.target.runtimeRepoId,
                  prNumber,
                  prRepo: options?.prRepo ?? null,
                  noCache: options?.force
                },
                { timeoutMs: 30_000 }
              )
            : ((await window.api.gh.prComments({
                repoPath,
                repoId,
                prNumber,
                prRepo: options?.prRepo ?? null,
                noCache: options?.force,
                sourceContext: options?.sourceContext
              })) as PRComment[])
        set((s) => ({
          commentsCache: withBoundedCacheEntry(s.commentsCache, cacheKey, {
            // Why: the cache key is per-repo/PR, not per-head, so the head the comments were
            // fetched against has to travel with them; inline rendering refuses to place a comment
            // on a line number that belongs to a different head.
            // A caller that omits the head records none rather than inheriting the previous one:
            // inheriting would stamp fresh comments with a stale head and let them render on the
            // wrong lines, while an absent head simply blocks inline placement.
            ...s.commentsCache[cacheKey],
            data: comments,
            fetchedAt: Date.now(),
            headSha: options?.headSha
          })
        }))
        return comments
      } catch (err) {
        console.error('Failed to fetch PR comments:', err)
        return get().commentsCache[cacheKey]?.data ?? []
      } finally {
        inflightCommentsRequests.delete(cacheKey)
      }
    })()

    inflightCommentsRequests.set(cacheKey, request)
    return request
  }
})
