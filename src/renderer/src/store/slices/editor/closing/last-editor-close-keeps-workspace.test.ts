// closeFile and closeAllFiles write no landing patch when they close a workspace's last editor
// (#96); a sync once restored the one that deselected it. The tabs slice is stubbed, so this pins
// the editor slice's own write only.
import { describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'
import type { AppState } from '../../../types'
import {
  createEditorStore,
  createFakeEditorDisk,
  stubEditorWindowWithDisk
} from '@/components/editor/autosave/editor-autosave-controller-test-fixture'

const storeRef = vi.hoisted((): { current: StoreApi<AppState> | null } => ({ current: null }))
vi.mock('@/store/index', () => ({ useAppStore: { getState: () => storeRef.current?.getState() } }))
vi.mock('@/lib/workspace/ownership/connection-context', () => ({
  getConnectionIdForFile: () => undefined
}))

const PATH = '/repo/a.ts'

function workspaceWithOnlyOneFile(): StoreApi<AppState> {
  stubEditorWindowWithDisk(createFakeEditorDisk({ [PATH]: '' }))
  const store = createEditorStore()
  storeRef.current = store
  store.setState({
    // The tabs slice is not in this partial store; dropping the row is all closeFile needs of it.
    closeUnifiedTab: (tabId: string) => {
      store.setState((s) => ({
        unifiedTabsByWorktree: {
          'wt-1': (s.unifiedTabsByWorktree['wt-1'] ?? []).filter((tab) => tab.id !== tabId)
        }
      }))
      return null
    },
    tabsByWorktree: { 'wt-1': [] },
    browserTabsByWorktree: {},
    activeBrowserTabIdByWorktree: {},
    unifiedTabsByWorktree: {
      'wt-1': [
        {
          id: PATH,
          entityId: PATH,
          groupId: 'group-1',
          worktreeId: 'wt-1',
          contentType: 'editor',
          label: 'a.ts',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 0
        }
      ]
    }
  })
  store.getState().openFile({
    filePath: PATH,
    relativePath: 'a.ts',
    worktreeId: 'wt-1',
    language: 'typescript',
    mode: 'edit'
  })
  return store
}

describe('closing the last editor of the active workspace', () => {
  it.each([
    ['closeFile', (store: StoreApi<AppState>) => store.getState().closeFile(PATH)],
    ['closeAllFiles', (store: StoreApi<AppState>) => store.getState().closeAllFiles()]
  ])('%s leaves the workspace selected', (_name, close) => {
    const store = workspaceWithOnlyOneFile()
    close(store)
    expect(store.getState().openFiles).toEqual([])
    expect(store.getState().activeWorktreeId).toBe('wt-1')
  })
})
