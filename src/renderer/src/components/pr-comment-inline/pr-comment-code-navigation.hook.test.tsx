// @vitest-environment happy-dom

import { act } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'

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
    placementAllowed: true,
    reviewBaseRefName
  })
  return null
}

async function settleRevealFrames(): Promise<void> {
  // Why poll rather than wait a fixed 40ms: the reveal is stamped two animation frames after the
  // open, and a fixed wait is exactly the thing that turns flaky on a loaded worker.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const state = useAppStore.getState()
    if (state.pendingEditorReveal || state.scrollToDiffCommentId) {
      return
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
  }
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
  useAppStore.setState(useAppStore.getInitialState(), true)
  navigate = null
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

  it('opens a plain Edit tab with a line reveal when no surface holds a hunk', async () => {
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
    // Why absent: 'edit' is the default view mode, so the store stores no entry for it.
    expect(useAppStore.getState().editorViewMode[editTab?.id ?? '']).toBeUndefined()
    expect(useAppStore.getState().pendingEditorReveal).toMatchObject({
      fileId: editTab?.id,
      line: 42
    })
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
