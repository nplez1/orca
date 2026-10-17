// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { useAppStore } from '@/store'
import { issueCacheKey as getIssueCacheKey } from '@/store/github/cache-identity'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { makeRepo, makeWorktree } from '../worktree-jump-palette-test-fixtures'
import { useWorktreeCardReviewDetails } from './use-worktree-card-review-details'

const initialState = useAppStore.getInitialState()

function repo(id: string, path: string, overrides: Partial<Repo> = {}): Repo {
  return { ...makeRepo(), id, path, ...overrides }
}

// Why: a workspace created from a task on another host lives in that project's repo there,
// while the issue stays in the repo the task was listed from. The card reads issue state out
// of `issueCache`, so it has to key that entry the same way the pane and the sweeps do.
const workspaceRepo = repo('repo-remote', '/volumes/remote/repo', {
  executionHostId: 'runtime:env-1'
})
const issueRepo = repo('repo-source', '/tmp/source')
const linkedWorkItem: NonNullable<Worktree['linkedWorkItem']> = {
  provider: 'github',
  type: 'issue',
  number: 97,
  title: 'History shows everything',
  url: 'https://github.com/acme/orca/issues/97',
  repoId: 'repo-source'
}

function renderDetails(worktree: Worktree, workspaceRow: Repo = workspaceRepo) {
  return renderHook(() =>
    useWorktreeCardReviewDetails({
      worktree,
      repo: workspaceRow,
      settings: initialState.settings,
      projectGroups: [],
      cardProps: ['issue'],
      newCardStyle: true
    })
  )
}

describe('useWorktreeCardReviewDetails issue cache key', () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true)
    useAppStore.setState({ repos: [workspaceRepo, issueRepo] })
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
  })

  it('keys the linked issue in the repo the item came from', () => {
    const { result } = renderDetails(
      makeWorktree('wt-history', 'History', {
        repoId: workspaceRepo.id,
        linkedIssue: 97,
        linkedWorkItem
      })
    )

    expect(result.current.issueCacheKey).toBe(
      getIssueCacheKey(issueRepo.path, issueRepo.id, 97, initialState.settings, null, null, true)
    )
    expect(result.current.issueCacheKey).not.toBe(
      getIssueCacheKey(
        workspaceRepo.path,
        workspaceRepo.id,
        97,
        initialState.settings,
        null,
        workspaceRepo.executionHostId,
        true
      )
    )
  })

  it('keeps the workspace repo when the item is a different work item', () => {
    const { result } = renderDetails(
      makeWorktree('wt-pr', 'From a PR', {
        repoId: workspaceRepo.id,
        linkedIssue: 97,
        linkedWorkItem: { ...linkedWorkItem, type: 'pr', number: 12 }
      })
    )

    expect(result.current.issueCacheKey).toBe(
      getIssueCacheKey(
        workspaceRepo.path,
        workspaceRepo.id,
        97,
        initialState.settings,
        null,
        workspaceRepo.executionHostId,
        true
      )
    )
  })

  it('keys nothing when the issue repo is not registered on this device', () => {
    useAppStore.setState({ repos: [workspaceRepo] })

    const { result } = renderDetails(
      makeWorktree('wt-history', 'History', {
        repoId: workspaceRepo.id,
        linkedIssue: 97,
        linkedWorkItem
      })
    )

    expect(result.current.issueCacheKey).toBe('')
  })
})
