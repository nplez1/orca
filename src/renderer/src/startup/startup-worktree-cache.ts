import type { DetectedWorktreeListResult } from '../../../shared/worktree/types'
import { timeRendererStartupStep, timeRendererStartupSyncStep } from './startup-diagnostics'

type StartupWorktreeCacheActions = {
  hydrateCachedWorktrees: (results: readonly DetectedWorktreeListResult[]) => void
}

export function startStartupWorktreeCacheRead(): Promise<DetectedWorktreeListResult[]> {
  return timeRendererStartupStep('worktree-cache-get', () =>
    window.api.worktrees.listCached()
  ).catch((error) => {
    console.warn('Failed to read cached worktrees for startup:', error)
    return []
  })
}

export async function hydrateStartupWorktreeCache(
  actions: StartupWorktreeCacheActions,
  cachedWorktreesPromise: Promise<DetectedWorktreeListResult[]>
): Promise<ReadonlySet<string>> {
  const results = await cachedWorktreesPromise
  timeRendererStartupSyncStep('hydrate-cached-worktrees', () => {
    actions.hydrateCachedWorktrees(results)
  })
  return new Set(results.map((result) => result.repoId))
}
