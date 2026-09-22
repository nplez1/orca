// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { FileExplorerNameFilterProjectionSource } from './file-explorer-name-filter-projection'

const useFileExplorerIgnoredPathsMock = vi.hoisted(() => vi.fn(() => []))

vi.mock('./use-file-explorer-ignored-paths', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, useFileExplorerIgnoredPaths: useFileExplorerIgnoredPathsMock }
})

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({ settings: { showGitIgnoredFiles: true }, updateSettings: vi.fn() })
}))

import { useFileExplorerVisibleRowProjection } from './useFileExplorerVisibleRowProjection'

const hostClassifiedNameFilter: FileExplorerNameFilterProjectionSource = {
  query: 'target',
  relativePaths: ['src/target.ts', 'ignored/target.ts'],
  ignoredRelativePaths: ['ignored/target.ts']
}

describe('useFileExplorerVisibleRowProjection with a host-classified ignored subset', () => {
  it('skips the git ignored-paths query and dims from the host answer', () => {
    const { result } = renderHook(() =>
      useFileExplorerVisibleRowProjection(
        'worktree-1',
        '/repo',
        {},
        new Set(),
        true,
        true,
        hostClassifiedNameFilter,
        new Set()
      )
    )

    // Why: this query is a check-ignore over up to 5000 paths per keystroke; the host already
    // classified the page, so it must not run at all.
    expect(useFileExplorerIgnoredPathsMock).toHaveBeenCalledWith(
      expect.objectContaining({ relativePaths: [], canLoadIgnoredPaths: false })
    )
    expect(result.current.ignoredByRelativePath.has('ignored/target.ts')).toBe(true)
  })
})
