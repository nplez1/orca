// @vitest-environment happy-dom

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppStore } from '@/store'
import type { GitBranchCompareSummary } from '../../../../shared/git-diff-compare-types'
import type { PRComment } from '../../../../shared/github/comment-types'
import { getPRCommentInlineId } from './pr-comment-inline-threads'
import { usePRCommentCodeNavigation } from './pr-comment-code-navigation'
import { flush, mountProbe, unmountProbes } from '../right-sidebar/source-control-hook-test-harness'

const WORKTREE_ID = 'repo-A::/repo/wt'
const WORKTREE_PATH = '/repo/wt'
const OID = 'a'.repeat(40)

function comment(overrides: Partial<PRComment> = {}): PRComment {
  return {
    id: 7,
    author: 'reviewer',
    authorAvatarUrl: '',
    body: 'this line is wrong',
    createdAt: '',
    url: 'https://github.com/o/r/pull/1#discussion_r7',
    path: 'src/a.ts',
    line: 42,
    ...overrides
  }
}

function compare(overrides: Partial<GitBranchCompareSummary> = {}): GitBranchCompareSummary {
  return {
    baseRef: 'origin/main',
    baseOid: OID,
    compareRef: 'HEAD',
    headOid: OID,
    mergeBase: OID,
    changedFiles: 1,
    status: 'ready',
    ...overrides
  }
}

let navigate: ((comment: PRComment) => boolean) | null = null

function Probe({ reviewBaseRefName = 'main' }: { reviewBaseRefName?: string | null }): null {
  navigate = usePRCommentCodeNavigation({
    worktreeId: WORKTREE_ID,
    worktreePath: WORKTREE_PATH,
    reviewBaseRefName
  })
  return null
}

async function settleRevealFrames(): Promise<void> {
  // Why fake timers rather than a real wait: the reveal is stamped two animation frames after the
  // open, and a wall-clock wait for them is exactly what turns flaky on a loaded worker.
  await act(async () => {
    vi.advanceTimersByTime(64)
  })
}

async function openComment(overrides: Partial<PRComment> = {}): Promise<void> {
  let opened = false
  await act(async () => {
    opened = navigate?.(comment(overrides)) ?? false
  })
  expect(opened).toBe(true)
  await flush()
  await settleRevealFrames()
}

beforeEach(() => {
  vi.useFakeTimers()
  useAppStore.setState(useAppStore.getInitialState(), true)
  navigate = null
})

afterEach(() => {
  vi.useRealTimers()
})

describe('usePRCommentCodeNavigation', () => {
  it('opens the branch diff and reveals the thread there', async () => {
    useAppStore.setState({
      gitBranchCompareSummaryByWorktree: { [WORKTREE_ID]: compare() },
      gitBranchChangesByWorktree: {
        [WORKTREE_ID]: [{ path: 'src/a.ts', status: 'modified', added: 2, removed: 1 }]
      }
    })
    await mountProbe(<Probe />)
    await openComment()

    const diffTab = useAppStore
      .getState()
      .openFiles.find((file) => file.relativePath === 'src/a.ts' && file.mode === 'diff')
    expect(diffTab).toMatchObject({ diffSource: 'branch', worktreeId: WORKTREE_ID })
    expect(useAppStore.getState().scrollToDiffCommentId).toBe(getPRCommentInlineId(7))
    // Why: only a Monaco tab consumes a line reveal, and a pending one would fire on a later toggle.
    expect(useAppStore.getState().pendingEditorReveal).toBeNull()
    unmountProbes()
  })

  it('opens an Edit tab in Changes mode when only the working tree changed', async () => {
    useAppStore.setState({
      gitBranchCompareSummaryByWorktree: { [WORKTREE_ID]: compare() },
      gitBranchChangesByWorktree: { [WORKTREE_ID]: [] },
      gitStatusByWorktree: {
        [WORKTREE_ID]: [{ path: 'src/a.ts', status: 'modified', area: 'unstaged' }]
      }
    })
    await mountProbe(<Probe />)
    await openComment()

    const editTab = useAppStore
      .getState()
      .openFiles.find((file) => file.relativePath === 'src/a.ts' && file.mode === 'edit')
    expect(editTab).toBeDefined()
    expect(useAppStore.getState().editorViewMode[editTab?.id ?? '']).toBe('changes')
    expect(useAppStore.getState().pendingEditorReveal).toBeNull()
    unmountProbes()
  })

  it('never opens a plain tab: it keeps the change surface with no reveal to wait for', async () => {
    useAppStore.setState({
      gitBranchCompareSummaryByWorktree: { [WORKTREE_ID]: compare() },
      gitBranchChangesByWorktree: { [WORKTREE_ID]: [] },
      gitStatusByWorktree: { [WORKTREE_ID]: [] }
    })
    await mountProbe(<Probe />)
    await openComment()

    const editTab = useAppStore
      .getState()
      .openFiles.find((file) => file.relativePath === 'src/a.ts' && file.mode === 'edit')
    expect(editTab).toBeDefined()
    // Changes mode explains its own empty result, which is why it beats a tab that shows no diff.
    expect(useAppStore.getState().editorViewMode[editTab?.id ?? '']).toBe('changes')
    expect(useAppStore.getState().pendingEditorReveal).toBeNull()
    unmountProbes()
  })

  it('refuses an outdated comment, whose line is no longer evidence', async () => {
    await mountProbe(<Probe />)
    let opened = true
    await act(async () => {
      opened = navigate?.(comment({ isOutdated: true })) ?? false
    })

    expect(opened).toBe(false)
    expect(useAppStore.getState().openFiles).toEqual([])
    unmountProbes()
  })
})
