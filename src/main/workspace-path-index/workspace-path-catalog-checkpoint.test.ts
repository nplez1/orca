import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { compareFileNames } from '../../shared/file-name-sort'
import { resolveWorkspacePathFoldLocale } from '../../shared/workspace-path-catalog'
import type {
  WorkspacePathCatalog,
  WorkspacePathCatalogMetadata
} from '../../shared/workspace-path-catalog'
import { publishWorkspacePathCatalog } from '../../shared/workspace-path-catalog-builder-publication'
import { queryWorkspacePathCatalog } from '../../shared/workspace-path-catalog-query'
import type { WorkspacePathSearchFenceIdentity } from '../../shared/workspace-path-search-contract'
import type { WorkspacePathSpillRecord } from './workspace-path-catalog-spill'
import {
  openWorkspacePathCatalogSpillReader,
  writeWorkspacePathCatalogSpill
} from './workspace-path-catalog-spill'
import {
  WORKSPACE_PATH_CATALOG_CHECKPOINT_MANIFEST_FILE,
  validateWorkspacePathCatalogCheckpointManifest,
  workspacePathCatalogCheckpointIdentityHash,
  type WorkspacePathCatalogCheckpointManifest
} from './workspace-path-catalog-checkpoint-manifest'
import {
  restoreWorkspacePathCatalogCheckpoint,
  type WorkspacePathCatalogCheckpointRestoreOutcome
} from './workspace-path-catalog-checkpoint-restore'
import {
  pruneWorkspacePathCatalogCheckpointsToBudget,
  publishWorkspacePathCatalogCheckpoint,
  readWorkspacePathCatalogCheckpointManifest,
  removeWorkspacePathCatalogCheckpoint,
  workspacePathCatalogCheckpointDirectory,
  workspacePathCatalogCheckpointPayloadPath
} from './workspace-path-catalog-checkpoint-store'
import { writeWorkspacePathCatalogCheckpoint } from './workspace-path-catalog-checkpoint-writer'

const FOLD_VERSION = 'locale-lowercase-v1'
const SCOPE_RULE_VERSION = 'quick-open-scope-v1'
const OWNERSHIP_KEY = 'local::checkpoint-root'
const SPILL_DIRECTORY_OFFSET = 8 + 4 + 32 * 1024

type SpilledCatalog = Extract<WorkspacePathCatalog, { storageKind: 'disk-spilled' }>

let temporaryDirectory: string | null = null

afterEach(async () => {
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
  temporaryDirectory = null
})

describe('workspace path catalog checkpoints', () => {
  it('round-trips a spilled generation and answers the same page after restore', async () => {
    const fixture = await setUp()
    const written = await writeSpilledGeneration(
      fixture.spillDirectory,
      fixture.source,
      'generation-1'
    )
    const result = await writeWorkspacePathCatalogCheckpoint({
      checkpointDirectory: fixture.checkpointDirectory,
      ownershipKey: OWNERSHIP_KEY,
      generation: { catalog: written }
    })
    expect(result.reusedSpillFile).toBe(true)
    expect(result.payloadBytes).toBeGreaterThan(0)

    const manifest = await readWorkspacePathCatalogCheckpointManifest(fixture.checkpointDirectory)
    expect(manifest).toMatchObject({
      generationId: 'generation-1',
      publishedScope: 'both',
      pathCount: fixture.source.length,
      foldVersion: FOLD_VERSION,
      scopeRuleVersion: SCOPE_RULE_VERSION
    })

    const restored = await restoreFor(fixture)
    expect(restored.restored).toBe(true)
    if (!restored.restored) {
      return
    }
    expect(restored.result.directoryValidationMilliseconds).toBeGreaterThanOrEqual(0)

    const identity = fenceIdentity('item-1')
    const original = await querySpilled(written, identity)
    const recovered = await querySpilled(
      spilledCatalog(restored.result.generation.catalog),
      identity
    )
    expect(recovered.count).toEqual(original.count)
    expect(recovered.rows).toEqual(original.rows)
  })

  it('treats a truncated, partial, or unreadable payload as absent', async () => {
    const fixture = await setUp()
    const written = await writeSpilledGeneration(
      fixture.spillDirectory,
      fixture.source,
      'generation-1'
    )
    await writeWorkspacePathCatalogCheckpoint({
      checkpointDirectory: fixture.checkpointDirectory,
      ownershipKey: OWNERSHIP_KEY,
      generation: { catalog: written }
    })
    const manifest = await readWorkspacePathCatalogCheckpointManifest(fixture.checkpointDirectory)
    const payloadPath = workspacePathCatalogCheckpointPayloadPath(
      fixture.checkpointDirectory,
      manifest?.payloadFile ?? ''
    )

    // Partial write: the payload never landed.
    await writeFile(payloadPath, '')
    await expect(restoreFor(fixture)).resolves.toMatchObject({
      restored: false,
      reason: 'absent'
    })

    // Truncated write: shorter than the manifest declares.
    await writeFile(payloadPath, 'ORCAPIDX')
    await expect(restoreFor(fixture)).resolves.toMatchObject({
      restored: false,
      reason: 'absent'
    })

    // Same length, damaged magic: the header no longer parses.
    await writeFile(payloadPath, Buffer.alloc(manifest?.payloadBytes ?? 0))
    await expect(restoreFor(fixture)).resolves.toMatchObject({
      restored: false,
      reason: 'payload-invalid'
    })
  })

  it('rejects a corrupt block directory before serving and a corrupt body at read time', async () => {
    const fixture = await setUp()
    const written = await writeSpilledGeneration(
      fixture.spillDirectory,
      fixture.source,
      'generation-1'
    )
    await writeWorkspacePathCatalogCheckpoint({
      checkpointDirectory: fixture.checkpointDirectory,
      ownershipKey: OWNERSHIP_KEY,
      generation: { catalog: written }
    })
    const manifest = await readWorkspacePathCatalogCheckpointManifest(fixture.checkpointDirectory)
    const payloadPath = workspacePathCatalogCheckpointPayloadPath(
      fixture.checkpointDirectory,
      manifest?.payloadFile ?? ''
    )
    const originalPayload = await readFile(payloadPath)

    // A directory entry claiming more paths than a block can hold is refused before serving.
    const forged = Buffer.from(originalPayload)
    forged.writeUInt32LE(0xffff_ffff, SPILL_DIRECTORY_OFFSET)
    await writeFile(payloadPath, forged)
    await expect(restoreFor(fixture)).resolves.toMatchObject({
      restored: false,
      reason: 'payload-invalid'
    })

    // A damaged payload body keeps a valid directory, so it loads and fails on read instead.
    const damaged = Buffer.from(originalPayload)
    const dataOffset = SPILL_DIRECTORY_OFFSET + fixture.source.length * 24
    damaged.writeUInt32LE(0xdead_beef, dataOffset)
    await writeFile(payloadPath, damaged)
    const restored = await restoreFor(fixture)
    expect(restored.restored).toBe(true)
    if (!restored.restored) {
      return
    }
    const reader = await openWorkspacePathCatalogSpillReader(
      spilledCatalog(restored.result.generation.catalog)
    )
    await expect(reader.readBlock(0)).rejects.toThrow('checksum mismatch')
    await reader.close()
  })

  it('treats a foreign identity, folding version, or scope rule as absent', async () => {
    const fixture = await setUp()
    const written = await writeSpilledGeneration(
      fixture.spillDirectory,
      fixture.source,
      'generation-1'
    )
    await writeWorkspacePathCatalogCheckpoint({
      checkpointDirectory: fixture.checkpointDirectory,
      ownershipKey: OWNERSHIP_KEY,
      generation: { catalog: written }
    })

    await expect(
      restoreFor(fixture, workspacePathCatalogCheckpointIdentityHash('/other/root'))
    ).resolves.toMatchObject({ restored: false, reason: 'absent' })

    await expect(
      restoreWith(fixture.checkpointDirectory, {
        foldVersion: 'some-other-fold'
      })
    ).resolves.toMatchObject({ restored: false, reason: 'fold-mismatch' })

    await expect(
      restoreWith(fixture.checkpointDirectory, {
        scopeRuleVersion: 'some-other-scope-rule'
      })
    ).resolves.toMatchObject({ restored: false, reason: 'policy-mismatch' })

    await expect(restoreFor(fixture)).resolves.toMatchObject({
      restored: true
    })
  })

  it('refuses a manifest copied under another identity directory', async () => {
    const fixture = await setUp()
    const written = await writeSpilledGeneration(
      fixture.spillDirectory,
      fixture.source,
      'generation-1'
    )
    await writeWorkspacePathCatalogCheckpoint({
      checkpointDirectory: fixture.checkpointDirectory,
      ownershipKey: OWNERSHIP_KEY,
      generation: { catalog: written }
    })
    const otherHash = workspacePathCatalogCheckpointIdentityHash('/other/root')
    const foreignDirectory = workspacePathCatalogCheckpointDirectory(
      fixture.checkpointRoot,
      otherHash
    )
    const payloadFile = (
      await readWorkspacePathCatalogCheckpointManifest(fixture.checkpointDirectory)
    )?.payloadFile
    await publishWorkspacePathCatalogCheckpoint(foreignDirectory, {
      ...(await readManifestFields(fixture.checkpointDirectory)),
      identityHash: otherHash,
      payloadFile: payloadFile ?? 'missing.wpc'
    })
    expect(await readWorkspacePathCatalogCheckpointManifest(foreignDirectory)).toBeNull()
    await expect(restoreFor(fixture, otherHash)).resolves.toMatchObject({
      restored: false,
      reason: 'absent'
    })
  })

  it('keeps one generation per root and prunes whole checkpoints to the disk budget', async () => {
    const fixture = await setUp()
    for (const generationId of ['generation-1', 'generation-2']) {
      const written = await writeSpilledGeneration(
        fixture.spillDirectory,
        fixture.source,
        generationId
      )
      await writeWorkspacePathCatalogCheckpoint({
        checkpointDirectory: fixture.checkpointDirectory,
        ownershipKey: OWNERSHIP_KEY,
        generation: { catalog: written }
      })
      const aged = new Date(Date.now() - 60_000)
      await utimes(fixture.checkpointDirectory, aged, aged)
    }
    expect(
      (await readdir(fixture.checkpointDirectory)).filter((name) => name.endsWith('.wpc'))
    ).toEqual(['generation-2.wpc'])

    // A second root survives while the budget only has room for one checkpoint.
    const otherHash = workspacePathCatalogCheckpointIdentityHash('/other/root')
    const otherDirectory = workspacePathCatalogCheckpointDirectory(
      fixture.checkpointRoot,
      otherHash
    )
    const otherWritten = await writeSpilledGeneration(
      fixture.spillDirectory,
      fixture.source,
      'other'
    )
    await writeWorkspacePathCatalogCheckpoint({
      checkpointDirectory: otherDirectory,
      ownershipKey: 'local::other-root',
      generation: { catalog: otherWritten }
    })
    const budgetBytes = (await measureDirectory(otherDirectory)) + 1
    await pruneWorkspacePathCatalogCheckpointsToBudget(fixture.checkpointRoot, budgetBytes)
    expect(await readdir(fixture.checkpointRoot)).toEqual([otherHash])

    await removeWorkspacePathCatalogCheckpoint(otherDirectory)
    expect(await readdir(fixture.checkpointRoot)).toEqual([])
  })

  it('keeps two roots isolated and never serves one payload for the other', async () => {
    const fixture = await setUp()
    const firstHash = workspacePathCatalogCheckpointIdentityHash('/root/a')
    const secondHash = workspacePathCatalogCheckpointIdentityHash('/root/b')
    for (const [hash, key, generationId] of [
      [firstHash, 'local::a', 'generation-a'],
      [secondHash, 'local::b', 'generation-b']
    ] as const) {
      const written = await writeSpilledGeneration(
        fixture.spillDirectory,
        fixture.source,
        generationId
      )
      await writeWorkspacePathCatalogCheckpoint({
        checkpointDirectory: workspacePathCatalogCheckpointDirectory(fixture.checkpointRoot, hash),
        ownershipKey: key,
        generation: { catalog: written }
      })
    }
    await removeWorkspacePathCatalogCheckpoint(
      workspacePathCatalogCheckpointDirectory(fixture.checkpointRoot, firstHash)
    )
    await expect(restoreFor(fixture, firstHash)).resolves.toMatchObject({
      restored: false,
      reason: 'absent'
    })
    const survivor = await restoreFor(fixture, secondHash)
    expect(survivor).toMatchObject({ restored: true })
    if (survivor.restored) {
      expect(survivor.result.manifest.generationId).toBe('generation-b')
    }
  })

  it('encodes a resident generation only on explicit opt-in and refuses one the root budget cannot hold', async () => {
    const fixture = await setUp()
    const resident = await buildResidentCatalog([
      'src/alpha/one.ts',
      'src/alpha/two.ts',
      'src/beta/deep/item-1.ts'
    ])
    expect(resident.storageKind).toBe('packed-folded')

    // Default policy: the 34–45% re-encode is opt-in, so an active root spends no build-lane CPU.
    await expect(
      writeWorkspacePathCatalogCheckpoint({
        checkpointDirectory: fixture.checkpointDirectory,
        ownershipKey: OWNERSHIP_KEY,
        generation: { catalog: resident }
      })
    ).rejects.toThrow('resident-encoder-disabled')

    await expect(
      writeWorkspacePathCatalogCheckpoint({
        checkpointDirectory: fixture.checkpointDirectory,
        ownershipKey: OWNERSHIP_KEY,
        generation: { catalog: resident },
        residentEncodeEnabled: true,
        perRootBudgetBytes: 1
      })
    ).rejects.toThrow('disk-budget')
    expect(await readWorkspacePathCatalogCheckpointManifest(fixture.checkpointDirectory)).toBeNull()

    await writeWorkspacePathCatalogCheckpoint({
      checkpointDirectory: fixture.checkpointDirectory,
      ownershipKey: OWNERSHIP_KEY,
      generation: { catalog: resident },
      residentEncodeEnabled: true,
      perRootBudgetBytes: 64 * 1024 * 1024
    })
    const restored = await restoreFor(fixture)
    expect(restored.restored).toBe(true)
    if (!restored.restored) {
      return
    }
    // The resident catalog must survive the re-encode with its rows intact.
    const recovered = await querySpilled(
      spilledCatalog(restored.result.generation.catalog),
      fenceIdentity('alpha')
    )
    expect(recovered.rows).toEqual(['src/alpha/one.ts', 'src/alpha/two.ts'])
  })

  it('reports a manifest whose payload was never written as absent', async () => {
    const fixture = await setUp()
    await publishWorkspacePathCatalogCheckpoint(fixture.checkpointDirectory, {
      schema: 'workspace-path-catalog-checkpoint',
      schemaVersion: 1,
      blockFormatVersion: 1,
      identityHash: fixture.identityHash,
      payloadFile: 'missing-generation.wpc',
      payloadBytes: 1234,
      payloadIdentityHash: 'unused',
      generationId: 'missing-generation',
      publishedScope: 'both',
      pathCount: fixture.source.length,
      blockCount: 1,
      foldVersion: FOLD_VERSION,
      foldLocale: resolveWorkspacePathFoldLocale(),
      scopeRuleVersion: SCOPE_RULE_VERSION,
      writtenAtMilliseconds: Date.now()
    })
    await expect(restoreFor(fixture)).resolves.toMatchObject({
      restored: false,
      reason: 'absent'
    })
  })
})

async function setUp(): Promise<{
  spillDirectory: string
  checkpointRoot: string
  identityHash: string
  checkpointDirectory: string
  source: WorkspacePathSpillRecord[]
}> {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'orca-path-checkpoint-'))
  const spillDirectory = join(temporaryDirectory, 'spill')
  const checkpointRoot = join(temporaryDirectory, 'checkpoints')
  const identityHash = workspacePathCatalogCheckpointIdentityHash(OWNERSHIP_KEY)
  const source: WorkspacePathSpillRecord[] = [
    { relativePath: 'src/item-10.ts', flags: 3 },
    { relativePath: 'src/item-2.ts', flags: 7 },
    { relativePath: 'src/İstanbul.ts', flags: 3 },
    { relativePath: 'src/nested/deep/item-1.ts', flags: 3 }
  ].sort((left, right) => compareFileNames(left.relativePath, right.relativePath))
  return {
    spillDirectory,
    checkpointRoot,
    identityHash,
    checkpointDirectory: workspacePathCatalogCheckpointDirectory(checkpointRoot, identityHash),
    source
  }
}

async function buildResidentCatalog(paths: readonly string[]): Promise<WorkspacePathCatalog> {
  const encoder = new TextEncoder()
  const records = paths.map((relativePath) => ({
    relativePath,
    foldedPath: relativePath.toLocaleLowerCase(resolveWorkspacePathFoldLocale()),
    originalUtf8Length: encoder.encode(relativePath).byteLength,
    flags: 3
  }))
  const catalog = publishWorkspacePathCatalog({
    records,
    generationId: 'resident-generation',
    storage: 'packed-folded',
    metadata: metadata(),
    originalUtf8Length: records.reduce((sum, record) => sum + record.originalUtf8Length, 0),
    foldedCodeUnitCount: records.reduce((sum, record) => sum + record.foldedPath.length, 0),
    retainedLookupBytes: 0,
    reservedBuildBytes: 0,
    maxBytes: 64 * 1024 * 1024,
    correlationId: '11111111-1111-4111-8111-111111111111'
  })
  if (!catalog) {
    throw new Error('Resident catalog publication failed')
  }
  return catalog
}

async function writeSpilledGeneration(
  spillDirectory: string,
  source: WorkspacePathSpillRecord[],
  generationId: string
): Promise<SpilledCatalog> {
  const written = await writeWorkspacePathCatalogSpill({
    directory: spillDirectory,
    identityKey: OWNERSHIP_KEY,
    generationId,
    metadata: metadata(),
    pathCount: source.length,
    records: {
      async *[Symbol.asyncIterator]() {
        for (const record of source) {
          yield record
        }
      }
    }
  })
  return spilledCatalog(written.catalog)
}

function spilledCatalog(catalog: WorkspacePathCatalog): SpilledCatalog {
  if (catalog.storageKind !== 'disk-spilled') {
    throw new Error('Expected disk-spilled catalog')
  }
  return catalog
}

function restoreFor(
  fixture: { checkpointRoot: string; identityHash: string },
  identityHash = fixture.identityHash
): Promise<WorkspacePathCatalogCheckpointRestoreOutcome> {
  return restoreWorkspacePathCatalogCheckpoint({
    checkpointDirectory: workspacePathCatalogCheckpointDirectory(
      fixture.checkpointRoot,
      identityHash
    ),
    expectedFoldVersion: FOLD_VERSION,
    expectedFoldLocale: resolveWorkspacePathFoldLocale(),
    expectedScopeRuleVersion: SCOPE_RULE_VERSION
  })
}

function restoreWith(
  checkpointDirectory: string,
  overrides: { foldVersion?: string; scopeRuleVersion?: string }
): Promise<WorkspacePathCatalogCheckpointRestoreOutcome> {
  return restoreWorkspacePathCatalogCheckpoint({
    checkpointDirectory,
    expectedFoldVersion: overrides.foldVersion ?? FOLD_VERSION,
    expectedFoldLocale: resolveWorkspacePathFoldLocale(),
    expectedScopeRuleVersion: overrides.scopeRuleVersion ?? SCOPE_RULE_VERSION
  })
}

async function readManifestFields(
  checkpointDirectory: string
): Promise<WorkspacePathCatalogCheckpointManifest> {
  const parsed: unknown = JSON.parse(
    await readFile(
      join(checkpointDirectory, WORKSPACE_PATH_CATALOG_CHECKPOINT_MANIFEST_FILE),
      'utf8'
    )
  )
  const manifest = validateWorkspacePathCatalogCheckpointManifest(parsed)
  if (!manifest) {
    throw new Error('Manifest is invalid')
  }
  return manifest
}

async function querySpilled(
  catalog: SpilledCatalog,
  identity: WorkspacePathSearchFenceIdentity
): Promise<{ count: unknown; rows: string[] }> {
  const reader = await openWorkspacePathCatalogSpillReader(catalog)
  try {
    const response = await queryWorkspacePathCatalog(catalog, {
      identity,
      readSpilledBlock: reader.readBlock
    })
    return {
      count: response.count,
      rows: response.rows.map((row) => row.relativePath)
    }
  } finally {
    await reader.close()
  }
}

async function measureDirectory(directory: string): Promise<number> {
  let bytes = 0
  for (const name of await readdir(directory)) {
    bytes += (await stat(join(directory, name))).size
  }
  return bytes
}

function fenceIdentity(query: string): WorkspacePathSearchFenceIdentity {
  return {
    query,
    consumer: { consumerId: 'checkpoint-test', sequence: 1 },
    owner: {
      executionHost: { provider: 'local', incarnationId: 'checkpoint-test' },
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
    pageBudget: {
      maxPaths: 5_000,
      maxSerializedBytes: Number.POSITIVE_INFINITY
    }
  }
}

function metadata(): WorkspacePathCatalogMetadata {
  return {
    foldLocale: resolveWorkspacePathFoldLocale(),
    foldVersion: FOLD_VERSION,
    scopeRuleVersion: SCOPE_RULE_VERSION,
    includedComplete: true,
    allComplete: true,
    classificationComplete: true,
    coverageExcludePathSegments: [],
    freshness: 'no-known-gap'
  }
}
