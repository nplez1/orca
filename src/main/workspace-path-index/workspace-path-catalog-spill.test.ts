import { mkdir, mkdtemp, open, readdir, rm, stat, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { compareFileNames } from '../../shared/file-name-sort'
import {
  assertWorkspacePathSearchEquivalent,
  runWorkspacePathSearchOracle
} from '../../shared/__fixtures__/workspace-path-search-oracle'
import { resolveWorkspacePathFoldLocale } from '../../shared/workspace-path-catalog'
import type { WorkspacePathSearchFenceIdentity } from '../../shared/workspace-path-search-contract'
import {
  queryWorkspacePathCatalog,
  WorkspacePathSearchCancelledError
} from '../../shared/workspace-path-catalog-query'
import type {
  WorkspacePathCatalog,
  WorkspacePathCatalogGeneration,
  WorkspacePathCatalogMetadata
} from '../../shared/workspace-path-catalog'
import type { WorkspacePathSpillRecord } from './workspace-path-catalog-spill'
import {
  cleanStaleWorkspacePathCatalogSpillDirectories,
  openWorkspacePathCatalogSpillReader,
  writeWorkspacePathCatalogSpill
} from './workspace-path-catalog-spill'
import {
  dropWorkspacePathIndexWorkerRoot,
  publishWorkspacePathIndexWorkerGeneration
} from './workspace-path-index-worker-generation'

let temporaryDirectory: string | null = null

afterEach(async () => {
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
  temporaryDirectory = null
})

describe('workspace path catalog spill files', () => {
  it('cleans stale process directories without touching the current process', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'orca-path-spill-stale-'))
    const currentDirectory = join(temporaryDirectory, String(process.pid))
    const staleDirectory = join(temporaryDirectory, '99999999')
    await mkdir(currentDirectory, { recursive: true })
    await mkdir(staleDirectory, { recursive: true })
    await writeFile(join(currentDirectory, 'live.wpc'), 'live')
    await writeFile(join(staleDirectory, 'stale.wpc'), 'stale')
    await cleanStaleWorkspacePathCatalogSpillDirectories(currentDirectory)
    expect(await readdir(temporaryDirectory)).toEqual([String(process.pid)])
    expect(await readdir(currentDirectory)).toEqual(['live.wpc'])
  })

  it('round-trips sorted blocks and validates identity, fold policy, and exact rows', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'orca-path-spill-'))
    const source: WorkspacePathSpillRecord[] = [
      { relativePath: 'src/item-10.ts', flags: 3 },
      { relativePath: 'src/item-2.ts', flags: 7 },
      { relativePath: 'src/İstanbul.ts', flags: 3 }
    ].sort((left, right) => compareFileNames(left.relativePath, right.relativePath))
    const written = await writeWorkspacePathCatalogSpill({
      directory: temporaryDirectory,
      identityKey: 'host::root-key',
      generationId: 'spill-generation-1',
      metadata: metadata(),
      pathCount: source.length,
      records: records(source)
    })
    expect(written.catalog.storageKind).toBe('disk-spilled')
    if (written.catalog.storageKind !== 'disk-spilled') {
      throw new Error('Expected disk-spilled catalog')
    }
    expect(written.fileBytes).toBe((await stat(written.catalog.spillFilePath)).size)
    const reader = await openWorkspacePathCatalogSpillReader(written.catalog)
    try {
      const block = await reader.readBlock(0)
      expect(block.originals).toEqual(source.map((record) => record.relativePath))
      expect(block.folded).toEqual(
        source.map((record) => record.relativePath.toLocaleLowerCase(metadata().foldLocale))
      )
      expect([...block.flags]).toEqual(source.map((record) => record.flags))
    } finally {
      await reader.close()
    }
    const queryReader = await openWorkspacePathCatalogSpillReader(written.catalog)
    try {
      const response = await queryWorkspacePathCatalog(written.catalog, {
        identity: spillIdentity('item'),
        readSpilledBlock: queryReader.readBlock
      })
      expect(response.count.value).toBe(2)
      expect(response.rows.map((row) => row.relativePath)).toEqual([
        'src/item-2.ts',
        'src/item-10.ts'
      ])
    } finally {
      await queryReader.close()
    }
    // The catalog's own spill identity is what binds it to the payload; a foreign identity is rejected.
    await expect(
      openWorkspacePathCatalogSpillReader({
        ...written.catalog,
        spillIdentityKey: 'different-host-hash'
      })
    ).rejects.toThrow('identity or policy')
  })

  it('retains the same byte-bounded page as the oracle in spilled mode', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'orca-path-spill-budget-'))
    const paths = Array.from(
      { length: 40 },
      (_unused, index) => `src/long-budget/"quoted-segment-${index}-${'x'.repeat(72)}"-target.ts`
    )
    const source: WorkspacePathSpillRecord[] = [...paths]
      .sort((left, right) => compareFileNames(left, right))
      .map((relativePath) => ({ relativePath, flags: 3 }))
    const emptyPageBytes = new TextEncoder().encode(
      JSON.stringify({ paths: [], totalCount: paths.length })
    ).length
    const pathBytes = new TextEncoder().encode(JSON.stringify(source[0]?.relativePath ?? '')).length
    const pageBudget = {
      maxPaths: 5_000,
      maxSerializedBytes: emptyPageBytes + pathBytes * 12 + 20
    }
    const written = await writeWorkspacePathCatalogSpill({
      directory: temporaryDirectory,
      identityKey: 'budget-root',
      generationId: 'spill-budget-generation',
      metadata: metadata(),
      pathCount: source.length,
      records: records(source)
    })
    expect(written.catalog.storageKind).toBe('disk-spilled')
    const expected = runWorkspacePathSearchOracle(paths, 'budget target', {
      scope: {
        rootPath: '/fixture',
        excludePaths: [],
        ignoredPaths: new Set<string>(),
        includeDotfiles: true,
        includeIgnoredFiles: true
      },
      pageBudget
    })
    expect(expected.paths.length).toBeGreaterThan(0)
    expect(expected.paths.length).toBeLessThan(paths.length)
    if (written.catalog.storageKind !== 'disk-spilled') {
      throw new Error('Expected disk-spilled catalog')
    }
    const reader = await openWorkspacePathCatalogSpillReader(written.catalog)
    try {
      const response = await queryWorkspacePathCatalog(written.catalog, {
        identity: spillIdentity('budget target', pageBudget),
        readSpilledBlock: reader.readBlock
      })
      assertWorkspacePathSearchEquivalent('budget target', expected, {
        paths: response.rows.map((row) => row.relativePath),
        totalCount: response.count.value ?? -1
      })
    } finally {
      await reader.close()
    }
  })

  it('rejects checksum failure and truncation before decoding a damaged block', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'orca-path-spill-corrupt-'))
    const source = [{ relativePath: 'src/corrupt-target.ts', flags: 3 }]
    const written = await writeWorkspacePathCatalogSpill({
      directory: temporaryDirectory,
      identityKey: 'spill-corrupt-root',
      generationId: 'spill-corrupt-generation',
      metadata: metadata(),
      pathCount: source.length,
      records: records(source)
    })
    if (written.catalog.storageKind !== 'disk-spilled') {
      throw new Error('Expected disk-spilled catalog')
    }
    const fileHandle = await open(written.catalog.spillFilePath, 'r+')
    const directoryEntry = Buffer.alloc(24)
    await fileHandle.read(
      directoryEntry,
      0,
      directoryEntry.byteLength,
      written.catalog.spillDirectoryOffset
    )
    const originalLength = directoryEntry.readUInt32LE(4)
    const corruptedByte = Buffer.alloc(1)
    await fileHandle.read(corruptedByte, 0, 1, written.catalog.spillDataOffset + originalLength)
    corruptedByte[0] = (corruptedByte[0] ?? 0) ^ 0xff
    await fileHandle.write(corruptedByte, 0, 1, written.catalog.spillDataOffset + originalLength)
    await fileHandle.close()

    const reader = await openWorkspacePathCatalogSpillReader(written.catalog)
    await expect(reader.readBlock(0)).rejects.toThrow('checksum mismatch')
    await reader.close()
    await truncate(written.catalog.spillFilePath, written.catalog.spillDataOffset + 1)
    const truncatedReader = await openWorkspacePathCatalogSpillReader(written.catalog)
    await expect(truncatedReader.readBlock(0)).rejects.toThrow('corrupt')
    await truncatedReader.close()
  })

  it('observes cancellation during a spilled block scan', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'orca-path-spill-scan-cancel-'))
    const source = Array.from({ length: 300 }, (_, index) => ({
      relativePath: `src/needle-${String(index).padStart(4, '0')}.ts`,
      flags: 3
    })).sort((left, right) => left.relativePath.localeCompare(right.relativePath))
    const written = await writeWorkspacePathCatalogSpill({
      directory: temporaryDirectory,
      identityKey: 'spill-scan-cancel-root',
      generationId: 'spill-scan-cancel-generation',
      metadata: metadata(),
      pathCount: source.length,
      records: records(source)
    })
    if (written.catalog.storageKind !== 'disk-spilled') {
      throw new Error('Expected disk-spilled catalog')
    }
    const reader = await openWorkspacePathCatalogSpillReader(written.catalog)
    let cancellationChecks = 0
    try {
      await expect(
        queryWorkspacePathCatalog(written.catalog, {
          identity: spillIdentity('needle'),
          readSpilledBlock: reader.readBlock,
          cancellation: { isCancelled: () => ++cancellationChecks >= 3 }
        })
      ).rejects.toBeInstanceOf(WorkspacePathSearchCancelledError)
    } finally {
      await reader.close()
    }
    expect(cancellationChecks).toBeGreaterThanOrEqual(3)
  })

  it('removes spill files on generation eviction and root disposal', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'orca-path-spill-eviction-'))
    const catalogs: Extract<WorkspacePathCatalog, { storageKind: 'disk-spilled' }>[] = []
    for (let index = 1; index <= 3; index += 1) {
      const written = await writeWorkspacePathCatalogSpill({
        directory: temporaryDirectory,
        identityKey: 'spill-eviction-root',
        generationId: `spill-eviction-generation-${index}`,
        metadata: metadata(),
        pathCount: 1,
        records: records([{ relativePath: `src/target-${index}.ts`, flags: 3 }])
      })
      if (written.catalog.storageKind !== 'disk-spilled') {
        throw new Error('Expected disk-spilled generation')
      }
      catalogs.push(written.catalog)
    }
    const generations = new Map<string, WorkspacePathCatalogGeneration>()
    const latestGenerationIds = new Map<string, string>()
    for (const catalog of catalogs) {
      publishWorkspacePathIndexWorkerGeneration({
        generations,
        latestGenerationIds,
        rootKey: 'spill-eviction-root',
        generationId: catalog.generationId,
        generation: { catalog }
      })
    }
    for (
      let attempt = 0;
      attempt < 50 && (await readdir(temporaryDirectory)).length > 2;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(await readdir(temporaryDirectory)).toHaveLength(2)
    dropWorkspacePathIndexWorkerRoot({
      generations,
      latestGenerationIds,
      rootKey: 'spill-eviction-root'
    })
    for (
      let attempt = 0;
      attempt < 50 && (await readdir(temporaryDirectory)).length > 0;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(await readdir(temporaryDirectory)).toEqual([])
  })

  it('enforces a bounded disk budget before publishing a spill', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'orca-path-spill-budget-'))
    await expect(
      writeWorkspacePathCatalogSpill({
        directory: temporaryDirectory,
        identityKey: 'spill-budget-root',
        generationId: 'spill-budget-generation',
        metadata: metadata(),
        pathCount: 1,
        records: records([{ relativePath: 'src/target.ts', flags: 3 }]),
        maxDiskBytes: 1
      })
    ).rejects.toThrow('directory exceeds safe bounds')
    expect(await readdir(temporaryDirectory)).toEqual([])
  })

  it('aborts a cancelled spill write and removes its temporary file', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'orca-path-spill-cancel-'))
    let seen = 0
    await expect(
      writeWorkspacePathCatalogSpill({
        directory: temporaryDirectory,
        identityKey: 'spill-cancel-root',
        generationId: 'spill-cancel-generation',
        metadata: metadata(),
        pathCount: 2,
        records: records([
          { relativePath: 'src/one.ts', flags: 3 },
          { relativePath: 'src/two.ts', flags: 3 }
        ]),
        cancellation: { isCancelled: () => ++seen >= 2 }
      })
    ).rejects.toThrow('cancelled')
    expect(await readdir(temporaryDirectory)).toEqual([])
  })
})

async function* records(
  paths: readonly WorkspacePathSpillRecord[]
): AsyncGenerator<WorkspacePathSpillRecord> {
  for (const path of paths) {
    yield path
  }
}

function spillIdentity(
  query: string,
  pageBudget: { maxPaths: number; maxSerializedBytes: number } = {
    maxPaths: 5_000,
    maxSerializedBytes: Number.POSITIVE_INFINITY
  }
): WorkspacePathSearchFenceIdentity {
  return {
    query,
    consumer: { consumerId: 'spilled-catalog-test', sequence: 1 },
    owner: {
      executionHost: { provider: 'local', incarnationId: 'spill-test' },
      authorizedCanonicalRoot: '/fixture'
    },
    generationId: null,
    mode: 'name-filter',
    scope: {
      pathSet: 'all',
      includeDotfiles: true,
      includeIgnoredFiles: true,
      excludePathSegments: []
    },
    pageBudget
  }
}

function metadata(): WorkspacePathCatalogMetadata {
  return {
    foldLocale: resolveWorkspacePathFoldLocale(),
    foldVersion: 'locale-lowercase-v1',
    scopeRuleVersion: 'quick-open-scope-v1',
    includedComplete: true,
    allComplete: true,
    classificationComplete: true,
    coverageExcludePathSegments: [],
    freshness: 'no-known-gap'
  }
}
