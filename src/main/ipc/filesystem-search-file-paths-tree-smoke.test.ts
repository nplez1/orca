import { afterEach, describe, expect, it } from 'vitest'
import { realpath } from 'node:fs/promises'
import type { Store } from '../persistence'
import { collectQuickOpenPaths } from './filesystem-search-file-paths'
import {
  createFilesystemPathTreeFixture,
  type FilesystemPathTreeFixture
} from './__fixtures__/filesystem-path-tree'

function createFilesystemTestStore(rootPath: string): Store {
  const partial = {
    getRepos: () => [
      {
        id: 'path-tree-fixture',
        path: rootPath,
        displayName: 'path-tree-fixture',
        badgeColor: '#000000',
        addedAt: 0,
        kind: 'git'
      }
    ],
    getSettings: () => ({})
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: collectQuickOpenPaths reads only getRepos/getSettings from this store fixture.
  return partial as unknown as Store
}

describe('collectQuickOpenPaths with a real generated tree', () => {
  let fixture: FilesystemPathTreeFixture | null = null

  afterEach(async () => {
    await fixture?.cleanup()
    fixture = null
  })

  it('enumerates every generated file under the temporary root', async () => {
    fixture = await createFilesystemPathTreeFixture()

    const result = await collectQuickOpenPaths(
      fixture.rootPath,
      createFilesystemTestStore(fixture.rootPath),
      {
        pass: 'included'
      }
    )
    expect(result.authorizedRootPath).toBe(await realpath(fixture.rootPath))
    expect(result.budgetExceeded).toBe(false)
    expect(result.paths).toHaveLength(fixture.relativePaths.length)
    expect(new Set(result.paths)).toEqual(new Set(fixture.relativePaths))
  }, 120_000)
})
