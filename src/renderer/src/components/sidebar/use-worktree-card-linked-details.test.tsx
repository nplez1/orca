// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { useAppStore } from '@/store'
import type { Worktree } from '../../../../shared/worktree/types'
import { makeWorktree } from '../worktree-jump-palette-test-fixtures'
import { useWorktreeCardLinkedDetails } from './use-worktree-card-linked-details'

const initialState = useAppStore.getInitialState()

const worktree: Worktree = makeWorktree('repo-1::/repo/worktrees/history', 'History', {
  linkedIssue: 97
})

function renderDetails(issueRepoIsOffDevice: boolean) {
  return renderHook(() =>
    useWorktreeCardLinkedDetails({
      worktree,
      newCardStyle: true,
      deleteState: undefined,
      branch: 'main',
      issueEntry: undefined,
      issueRepoIsOffDevice,
      linearIssueEntry: undefined,
      linearIssueFallbackEntry: undefined,
      prDisplay: null
    })
  )
}

describe('useWorktreeCardLinkedDetails issue display', () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true)
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
  })

  it('settles as unavailable when the issue repo is not on this device', () => {
    // Why: such a link has no cache entry and never will — spinning would claim a fetch that
    // cannot be made, and the pane already says the repo is missing.
    const { result } = renderDetails(true)

    expect(result.current.issueDisplay).toMatchObject({
      number: 97,
      title: 'Issue details unavailable'
    })
  })

  it('keeps the loading title for a link that is simply not fetched yet', () => {
    const { result } = renderDetails(false)

    expect(result.current.issueDisplay).toMatchObject({ number: 97, title: 'Loading issue...' })
  })
})
