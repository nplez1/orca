import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { GitHubSlice } from './slice-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { rightSidebarShowsPullRequestData } from '@/lib/right-sidebar-visibility'
import { issueCacheKey } from './cache-identity'
import { CACHE_TTL } from './cache-policy'
import { settingsForGitHubRepoOwner } from './work-item-routing'
import { getGitHubRepoLookupIndex } from '../slices/github-repo-lookup-index'
import { findLinkedIssueRepo } from '@/lib/linked-issue-repo'
import { selectWorktreesByRepo } from '../workspace-record-selectors'

export const createStaleWorktreeRefreshActions = (
  get: Parameters<StateCreator<AppState>>[1]
): Pick<GitHubSlice, 'refreshGitHubForWorktreeIfStale'> => ({
  // Why: activation is the strongest freshness signal; route through the coordinator to keep coalescing/rate-limit guards.
  refreshGitHubForWorktreeIfStale: (worktreeId) => {
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

    const now = Date.now()
    const branch = worktree.branch.replace(/^refs\/heads\//, '')
    const cardProps = state.worktreeCardProperties ?? []
    const shouldRefreshPR =
      state.groupBy === 'pr-status' ||
      (state.settings?.experimentalNewWorktreeCardStyle === true
        ? cardProps.includes('status')
        : cardProps.includes('pr') || cardProps.some((property: string) => property === 'ci')) ||
      rightSidebarShowsPullRequestData(state)

    if (shouldRefreshPR && !worktree.isBare && branch) {
      get().enqueueGitHubPRRefresh(worktreeId, 'active', 80)
    }

    if ((state.worktreeCardProperties ?? []).includes('issue') && worktree.linkedIssue) {
      // Why the link's repo rather than the workspace row: see `linked-issue-repo.ts`.
      const issueRepo = findLinkedIssueRepo(state.repos, worktree, worktree.linkedIssue)
      if (issueRepo) {
        const ownerSettings = settingsForGitHubRepoOwner(state.settings, issueRepo)
        const issueKey = issueCacheKey(
          issueRepo.path,
          issueRepo.id,
          worktree.linkedIssue,
          ownerSettings,
          issueRepo.connectionId,
          issueRepo.executionHostId,
          true
        )
        const issueEntry = state.issueCache[issueKey]
        if (!issueEntry || now - issueEntry.fetchedAt >= CACHE_TTL) {
          void get().fetchIssue(issueRepo.path, worktree.linkedIssue, { repoId: issueRepo.id })
        }
      }
    }
  }
})
