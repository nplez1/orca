import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WORKSPACE_PATH_CATALOG_FLAGS } from '../../shared/workspace-path-catalog'
import { compareFileNames } from '../../shared/file-name-sort'
import { generateWorkspacePathCatalog } from '../../shared/__fixtures__/workspace-path-catalog'
import {
  runWorkspacePathSearchOracle,
  assertWorkspacePathSearchEquivalent
} from '../../shared/__fixtures__/workspace-path-search-oracle'
import { WORKSPACE_PATH_SEARCH_QUERY_BATTERY } from '../../shared/__fixtures__/workspace-path-search-query-battery'
import type {
  WorkspacePathSearchFenceIdentity,
  WorkspacePathSearchScopeDescriptor
} from '../../shared/workspace-path-search-contract'
import { queryWorkspacePathCatalog } from '../../shared/workspace-path-catalog-query'
import { openWorkspacePathCatalogSpillReader } from './workspace-path-catalog-spill'
import { WorkspacePathCatalogSpillRuns } from './workspace-path-catalog-spill-runs'

let temporaryDirectory: string | null = null

afterEach(async () => {
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
  temporaryDirectory = null
})

describe('workspace path spill build runs', () => {
  it.each(['realistic-shared-prefixes', 'adversarial-long-unshared'] as const)(
    'matches the oracle battery and all scopes for a spilled %s catalog',
    async (shape) => {
      temporaryDirectory = await mkdtemp(join(tmpdir(), 'orca-path-spill-parity-'))
      const paths = [...generateWorkspacePathCatalog({ size: 500, shape, seed: 0x50455246 })]
      const ignoredPaths = new Set(['ignored/reports/target-ignored.ts'])
      const runs = new WorkspacePathCatalogSpillRuns(
        temporaryDirectory,
        `spill-parity-${shape}`,
        `spill-parity-generation-${shape}`
      )
      expect(
        await runs.addBatch(
          'included',
          paths.filter((path) => !ignoredPaths.has(path))
        )
      ).toBe(true)
      expect(await runs.finishFirstScope('included')).not.toBeNull()
      expect(await runs.addBatch('all', paths)).toBe(true)
      const completed = await runs.finishAllScopes('all', `spill-parity-complete-${shape}`)
      expect(completed).not.toBeNull()
      if (!completed || completed.catalog.storageKind !== 'disk-spilled') {
        throw new Error('Expected completed spill catalog')
      }
      const oraclePaths = paths.filter((path) => !path.startsWith('node_modules/'))
      for (const scope of spilledScopes()) {
        for (const { query } of WORKSPACE_PATH_SEARCH_QUERY_BATTERY) {
          const expectedPaths =
            scope.pathSet === 'included'
              ? oraclePaths.filter((path) => !ignoredPaths.has(path))
              : oraclePaths
          const expected = runWorkspacePathSearchOracle(expectedPaths, query, {
            scope: {
              rootPath: '/fixture',
              excludePaths: scope.excludePathSegments.map(
                (segments) => `/fixture/${segments.join('/')}`
              ),
              ignoredPaths,
              includeDotfiles: scope.includeDotfiles,
              includeIgnoredFiles: scope.includeIgnoredFiles
            }
          })
          const reader = await openWorkspacePathCatalogSpillReader(completed.catalog)
          try {
            const actual = await queryWorkspacePathCatalog(completed.catalog, {
              identity: spilledIdentity(query, scope),
              readSpilledBlock: reader.readBlock
            })
            assertWorkspacePathSearchEquivalent(query, expected, {
              paths: actual.rows.map((row) => row.relativePath),
              totalCount: actual.count.value ?? -1
            })
          } finally {
            await reader.close()
          }
        }
      }
      await runs.cleanupScratch()
    }
  )

  it('naturally merges scopes, deduplicates paths, classifies, and preserves exact order', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'orca-path-runs-'))
    const runs = new WorkspacePathCatalogSpillRuns(
      temporaryDirectory,
      'spill-run-root',
      'spill-run-generation'
    )
    expect(
      await runs.addBatch('included', [
        'src/item-10-target.ts',
        'src/item-2-target.ts',
        'src/item-2-target.ts'
      ])
    ).toBe(true)
    const first = await runs.finishFirstScope('included')
    expect(first).not.toBeNull()
    if (!first || first.catalog.storageKind !== 'disk-spilled') {
      throw new Error('Expected first scope spill')
    }
    const firstReader = await openWorkspacePathCatalogSpillReader(first.catalog)
    try {
      const firstBlock = await firstReader.readBlock(0)
      expect(firstBlock.originals).toEqual(['src/item-2-target.ts', 'src/item-10-target.ts'])
    } finally {
      await firstReader.close()
    }

    expect(
      await runs.addBatch('all', [
        'ignored/target.txt',
        'src/item-2-target.ts',
        'src/item-10-target.ts',
        'src/item-02-target.ts'
      ])
    ).toBe(true)
    const complete = await runs.finishAllScopes('all', 'spill-run-complete')
    expect(complete).not.toBeNull()
    if (!complete || complete.catalog.storageKind !== 'disk-spilled') {
      throw new Error('Expected complete spill catalog')
    }
    expect(complete.catalog.pathCount).toBe(4)
    const reader = await openWorkspacePathCatalogSpillReader(complete.catalog)
    const records: { path: string; flags: number }[] = []
    try {
      for (let blockIndex = 0; blockIndex < complete.catalog.spillBlockCount; blockIndex += 1) {
        const block = await reader.readBlock(blockIndex)
        for (let index = 0; index < block.originals.length; index += 1) {
          records.push({
            path: block.originals[index] ?? '',
            flags: block.flags[index] ?? 0
          })
        }
      }
    } finally {
      await reader.close()
    }
    expect(records.map((record) => record.path)).toEqual(
      records.map((record) => record.path).sort(compareFileNames)
    )
    expect(records.map((record) => record.path)).toEqual([
      'ignored/target.txt',
      'src/item-02-target.ts',
      'src/item-2-target.ts',
      'src/item-10-target.ts'
    ])
    const includedFlags =
      records.find((record) => record.path === 'src/item-2-target.ts')?.flags ?? 0
    expect(includedFlags & WORKSPACE_PATH_CATALOG_FLAGS.included).not.toBe(0)
    expect(includedFlags & WORKSPACE_PATH_CATALOG_FLAGS.ignoreClassificationKnown).not.toBe(0)
    expect(includedFlags & WORKSPACE_PATH_CATALOG_FLAGS.ignored).toBe(0)
    const ignoredFlags = records.find((record) => record.path === 'ignored/target.txt')?.flags ?? 0
    expect(ignoredFlags & WORKSPACE_PATH_CATALOG_FLAGS.ignored).not.toBe(0)
    await runs.cleanupScratch()
  })
})

function spilledScopes(): WorkspacePathSearchScopeDescriptor[] {
  const scopes: WorkspacePathSearchScopeDescriptor[] = []
  for (const pathSet of ['included', 'all'] as const) {
    for (const includeDotfiles of [false, true]) {
      for (const includeIgnoredFiles of [false, true]) {
        for (const includeExcludes of [false, true]) {
          scopes.push({
            pathSet,
            includeDotfiles,
            includeIgnoredFiles,
            excludePathSegments: includeExcludes ? [['packages', 'app']] : []
          })
        }
      }
    }
  }
  return scopes
}

function spilledIdentity(
  query: string,
  scope: WorkspacePathSearchScopeDescriptor
): WorkspacePathSearchFenceIdentity {
  return {
    query,
    consumer: { consumerId: 'spill-parity', sequence: 1 },
    owner: {
      executionHost: { provider: 'local', incarnationId: 'spill-parity-host' },
      authorizedCanonicalRoot: '/fixture'
    },
    generationId: null,
    mode: 'name-filter',
    scope,
    pageBudget: {
      maxPaths: 5_000,
      maxSerializedBytes: Number.POSITIVE_INFINITY
    }
  }
}
