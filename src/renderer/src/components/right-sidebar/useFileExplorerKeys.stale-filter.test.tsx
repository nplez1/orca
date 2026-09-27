// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { createFileExplorerRowProjection } from './file-explorer-row-projection'
import type { TreeNode } from './file-explorer-types'
import { useFileExplorerKeys } from './useFileExplorerKeys'

const initialAppState = useAppStore.getInitialState()
const staleNode: TreeNode = {
  name: 'old-result.ts',
  path: '/repo/old-result.ts',
  relativePath: 'old-result.ts',
  isDirectory: false,
  depth: 0
}

describe('file explorer stale-filter keyboard activation', () => {
  beforeEach(() => {
    useAppStore.setState(initialAppState, true)
    useAppStore.setState({
      rightSidebarOpen: true,
      rightSidebarTab: 'explorer',
      rightSidebarExplorerView: 'files'
    })
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialAppState, true)
  })

  it('blocks Enter rename and Space activation while the visible page belongs to an older query', () => {
    const container = document.createElement('div')
    container.tabIndex = -1
    document.body.appendChild(container)
    container.focus()
    const activateNode = vi.fn()
    const startRename = vi.fn()

    renderHook(() =>
      useFileExplorerKeys({
        containerRef: { current: container },
        rowProjection: createFileExplorerRowProjection([staleNode]),
        expandedPaths: new Set(),
        canToggleDirectories: true,
        inlineInput: null,
        selectedPaths: new Set([staleNode.path]),
        selectedNode: staleNode,
        canActivateRows: false,
        activateNode,
        moveSelection: vi.fn(),
        toggleDir: vi.fn(),
        startRename,
        requestDelete: vi.fn(),
        requestDeleteAll: vi.fn(),
        scrollToIndex: vi.fn(),
        activeWorktreeId: 'worktree-1'
      })
    )

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    })

    expect(startRename).not.toHaveBeenCalled()
    expect(activateNode).not.toHaveBeenCalled()
    container.remove()
  })
})
