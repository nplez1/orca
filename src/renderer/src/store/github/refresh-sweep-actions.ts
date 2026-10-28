import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { GitHubSlice } from './slice-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { getGitHubRepoLookupIndex } from '../slices/github-repo-lookup-index'
import { issueCacheKey, prCacheKey } from './cache-identity'
import { CACHE_TTL, evictStaleEntries } from './cache-policy'
import { pruneExpiredPRRefreshStates } from './pr-refresh-state'
import { settingsForGitHubRepoOwner } from './work-item-routing'
import { findLinkedIssueRepo } from '@/lib/linked-issue-repo'
import { selectWorktreesByRepo } from '../workspace-record-selectors'

export const createRefreshSweepActions = (
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): Pick<GitHubSlice, 'refreshAllGitHub' | 'refreshGitHubForWorktree'> => ({
  refreshAllGitHub: () => {
    // Clear comments cache; evict stale entries to bound long-session growth across repos/branches.
    set((s) => {
      const next = {
        commentsCache: Object.keys(s.commentsCache).length === 0 ? s.commentsCache : {},
        prCache: evictStaleEntries(s.prCache),
        issueCache: evictStaleEntries(s.issueCache),
        checksCache: evictStaleEntries(s.checksCache),
        workItemsCache: evictStaleEntries(s.workItemsCache),
        projectViewCache: evictStaleEntries(s.projectViewCache),
        prRefreshStates: pruneExpiredPRRefreshStates(s.prRefreshStates)
      }
      // Unchanged eviction returns input maps; return s too so window-resume sweeps do not wake every subscriber.
      return next.commentsCache === s.commentsCache &&
        next.prCache === s.prCache &&
        next.issueCache === s.issueCache &&
        next.checksCache === s.checksCache &&
        next.workItemsCache === s.workItemsCache &&
        next.projectViewCache === s.projectViewCache &&
        next.prRefreshStates === s.prRefreshStates
        ? s
        : next
    })

    // Why: don't prune prRequestGenerations here — deleting a live generation makes its response look stale.

    const state = get()
    if (!(state.worktreeCardProperties ?? []).includes('issue')) {
      return
    }

    const now = Date.now()
    const repoLookup = getGitHubRepoLookupIndex(state.repos)

    for (const worktrees of Object.values(selectWorktreesByRepo(state))) {
      for (const wt of worktrees) {
        const repo = repoLookup.findById(wt.repoId)
        if (!repo) {
          continue
        }

        if (wt.linkedIssue) {
          // Why the link's repo: a workspace created from a task on another host lives in that
          // project's repo while the issue stays where the task was listed, so the workspace
          // row would key a fetch the card never reads. Same helper as the card and the pane.
          const issueRepo = findLinkedIssueRepo(state.repos, wt, wt.linkedIssue)
          if (!issueRepo) {
            continue
          }
          const ownerSettings = settingsForGitHubRepoOwner(state.settings, issueRepo)
          const issueKey = issueCacheKey(
            issueRepo.path,
            issueRepo.id,
            wt.linkedIssue,
            ownerSettings,
            issueRepo.connectionId,
            issueRepo.executionHostId,
            true
          )
          const issueEntry = state.issueCache[issueKey]
          if (!issueEntry || now - issueEntry.fetchedAt >= CACHE_TTL) {
            void get().fetchIssue(issueRepo.path, wt.linkedIssue, { repoId: issueRepo.id })
          }
        }
      }
    }
  },

  refreshGitHubForWorktree: (worktreeId) => {
    const state = get()
    let worktree: Worktree | undefined
    for (const worktrees of Object.values(selectWorktreesByRepo(state))) {
      worktree = worktrees.find((w) => w.id === worktreeId)
      if (worktree) {
        break
      }
    }
    if (!worktree) {
      return
    }

    const repoLookup = getGitHubRepoLookupIndex(state.repos)
    const repo = repoLookup.findById(worktree.repoId)
    if (!repo) {
      return
    }

    const branch = worktree.branch.replace(/^refs\/heads\//, '')
    const ownerSettings = settingsForGitHubRepoOwner(state.settings, repo)
    const prKey = prCacheKey(
      repo.path,
      repo.id,
      branch,
      ownerSettings,
      repo.connectionId,
      repo.executionHostId
    )
    // Why the link's repo: the issue lives where the task was listed, which is not always
    // this workspace's repo — keying off the workspace invalidates an entry the card never
    // reads and refetches through the wrong repo.
    const issueRepo = worktree.linkedIssue
      ? findLinkedIssueRepo(state.repos, worktree, worktree.linkedIssue)
      : null
    const issueKey =
      issueRepo && worktree.linkedIssue
        ? issueCacheKey(
            issueRepo.path,
            issueRepo.id,
            worktree.linkedIssue,
            settingsForGitHubRepoOwner(state.settings, issueRepo),
            issueRepo.connectionId,
            issueRepo.executionHostId,
            true
          )
        : ''

    set((s) => {
      const updates: Partial<AppState> = {}
      if (s.prCache[prKey]) {
        updates.prCache = { ...s.prCache, [prKey]: { ...s.prCache[prKey], fetchedAt: 0 } }
      }
      if (issueKey && s.issueCache[issueKey]) {
        updates.issueCache = {
          ...s.issueCache,
          [issueKey]: { ...s.issueCache[issueKey], fetchedAt: 0 }
        }
      }
      return updates
    })

    if (!worktree.isBare && branch) {
      get().enqueueGitHubPRRefresh(worktreeId, 'post-push', 100)
    }
    if (
      (state.worktreeCardProperties ?? []).includes('issue') &&
      worktree.linkedIssue &&
      issueRepo
    ) {
      void get().fetchIssue(issueRepo.path, worktree.linkedIssue, { repoId: issueRepo.id })
    }
  }
})
