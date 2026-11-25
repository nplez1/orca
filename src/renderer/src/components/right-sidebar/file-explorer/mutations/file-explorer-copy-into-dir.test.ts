import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileExplorerOperationGuard } from '../navigation/file-explorer-operation-owner'
import type { RuntimeFileOperationArgs } from '@/runtime/files/runtime-file-client-types'

type CopyHost = { existing: Set<string>; copyFailures: Error[]; copies: [string, string][] }
const runtime = vi.hoisted((): CopyHost => ({ existing: new Set(), copyFailures: [], copies: [] }))

vi.mock('@/runtime/files/metadata/runtime-file-metadata-client', () => ({
  runtimePathExists: async (_context: unknown, path: string) => runtime.existing.has(path)
}))
vi.mock('@/runtime/files/mutations/runtime-file-mutation-client', () => ({
  copyRuntimePath: async (_context: unknown, from: string, to: string) => {
    const failure = runtime.copyFailures.shift()
    if (failure) {
      throw failure
    }
    runtime.copies.push([from, to])
  }
}))

const { copyFileIntoDir } = await import('./file-explorer-copy-into-dir')

const target = { kind: 'local' } as const
const context: RuntimeFileOperationArgs = { target, worktreeId: 'wt', worktreePath: '/w' }
const operationGuard: FileExplorerOperationGuard = {
  route: { target },
  assertCurrent: () => ({ target })
}
const copy = (sourcePath: string, destDir: string): Promise<string> =>
  copyFileIntoDir({ context, operationGuard, sourcePath, destDir })

describe('copyFileIntoDir', () => {
  beforeEach(() => {
    runtime.existing.clear()
    runtime.copyFailures = []
    runtime.copies = []
  })

  it('keeps the name when the destination folder has none, and never targets an existing path', async () => {
    expect(await copy('/w/src/a.ts', '/w/lib')).toBe('/w/lib/a.ts')
    runtime.existing.add('/w/lib/a.ts').add('/w/lib/a copy.ts')
    expect(await copy('/w/src/a.ts', '/w/lib')).toBe('/w/lib/a copy 2.ts')
    expect(runtime.copies.map(([, to]) => to)).toEqual(['/w/lib/a.ts', '/w/lib/a copy 2.ts'])
  })

  it('duplicates in place under the copy name', async () => {
    expect(await copy('/w/src/a.ts', '/w/src')).toBe('/w/src/a copy.ts')
  })

  it('moves to the next name when the exclusive copy loses a race, and rethrows anything else', async () => {
    runtime.copyFailures = [new Error('EEXIST: file already exists')]
    expect(await copy('/w/src/a.ts', '/w/lib')).toBe('/w/lib/a copy.ts')

    runtime.copyFailures = [new Error('EACCES: permission denied')]
    await expect(copy('/w/src/b.ts', '/w/lib')).rejects.toThrow('EACCES')
  })
})
