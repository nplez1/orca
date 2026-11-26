import { beforeEach, describe, expect, it, vi } from 'vitest'

type MoveHost = { existing: Set<string>; moveFailure: Error | null; moves: [string, string][] }
const host = vi.hoisted((): MoveHost => ({ existing: new Set(), moveFailure: null, moves: [] }))

vi.mock('@/lib/editor/file-operations/execute-open-editor-path-move', () => {
  class EditorPathMoveRetargetError extends Error {}
  return {
    EditorPathMoveRetargetError,
    executeOpenEditorPathMove: async ({
      fromPath,
      toPath
    }: {
      fromPath: string
      toPath: string
    }) => {
      if (host.moveFailure) {
        throw host.moveFailure
      }
      host.moves.push([fromPath, toPath])
    }
  }
})
vi.mock('@/runtime/files/metadata/runtime-file-metadata-client', () => ({
  runtimePathExists: async (_context: unknown, path: string) => host.existing.has(path)
}))
vi.mock('../navigation/file-explorer-operation-owner', () => ({
  captureFileExplorerOperationGuard: () => ({
    route: { target: { kind: 'local' } },
    assertCurrent: () => ({})
  })
}))

const { moveFileExplorerPath } = await import('./useFileExplorerMoveDrop')
const { EditorPathMoveRetargetError } =
  await import('@/lib/editor/file-operations/execute-open-editor-path-move')
const { clearFileExplorerUndoHistory, undoFileExplorer } = await import('./fileExplorerUndoRedo')

const refreshDir = vi.fn(async () => {})
const move = (sourcePath: string, destDir: string) =>
  moveFileExplorerPath(
    {
      worktreePath: '/w',
      activeWorktreeId: 'wt',
      refreshDir,
      getOperationOwnerForPath: () => ({ kind: 'local' })
    },
    sourcePath,
    destDir
  )

describe('moveFileExplorerPath', () => {
  beforeEach(() => {
    host.existing.clear()
    host.moveFailure = null
    host.moves = []
    refreshDir.mockReset().mockResolvedValue(undefined)
    clearFileExplorerUndoHistory()
  })

  it('skips same-folder and into-subtree destinations without touching disk', async () => {
    expect(await move('/w/src/a.ts', '/w/src')).toEqual({ status: 'skipped' })
    expect(await move('/w/src', '/w/src/lib')).toEqual({ status: 'skipped' })
    expect(host.moves).toEqual([])
  })

  it('refuses an occupied destination name before renaming', async () => {
    host.existing.add('/w/lib/a.ts')
    expect(await move('/w/src/a.ts', '/w/lib')).toEqual({
      status: 'failed',
      message: "An item named 'a.ts' already exists in that folder."
    })
    expect(host.moves).toEqual([])
  })

  it('reports a completed move whose refresh failed as moved, and undoes it', async () => {
    refreshDir.mockRejectedValueOnce(new Error('refresh failed'))
    expect(await move('/w/src/a.ts', '/w/lib')).toEqual({ status: 'moved' })
    expect(await undoFileExplorer()).toBe(true)
    expect(host.moves).toEqual([
      ['/w/src/a.ts', '/w/lib/a.ts'],
      ['/w/lib/a.ts', '/w/src/a.ts']
    ])
  })

  it('keeps the stranded-file message when a failed rollback reports EEXIST', async () => {
    const stranded =
      'Could not retarget open editors for the move (stale). The on-disk move could not be undone and the file may remain at the new path: EEXIST: file already exists'
    host.moveFailure = new EditorPathMoveRetargetError(stranded)
    expect(await move('/w/src/a.ts', '/w/lib')).toEqual({ status: 'failed', message: stranded })

    host.moveFailure = new Error('EEXIST: file already exists')
    expect(await move('/w/src/a.ts', '/w/lib')).toEqual({
      status: 'failed',
      message: "An item named 'a.ts' already exists in that folder."
    })
  })
})
