import { mkdtemp, readdir, rm, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { compareFileNames } from '../../shared/file-name-sort'
import {
  resolveWorkspacePathFoldLocale,
  type WorkspacePathCatalog,
  type WorkspacePathCatalogMetadata
} from '../../shared/workspace-path-catalog'
import { workspacePathCatalogCheckpointIdentityHash } from './workspace-path-catalog-checkpoint-manifest'
import {
  WORKSPACE_PATH_CATALOG_CHECKPOINT_RESIDENT_ENCODE_ENV,
  workspacePathCatalogResidentCheckpointEncodeEnabled
} from './workspace-path-catalog-checkpoint-policy'
import {
  pruneWorkspacePathCatalogCheckpointsToBudget,
  readWorkspacePathCatalogCheckpointManifest,
  workspacePathCatalogCheckpointDirectory
} from './workspace-path-catalog-checkpoint-store'
import { writeWorkspacePathCatalogCheckpoint } from './workspace-path-catalog-checkpoint-writer'
import {
  writeWorkspacePathCatalogSpill,
  type WorkspacePathSpillRecord
} from './workspace-path-catalog-spill'

const FOLD_VERSION = 'locale-lowercase-v1'
const SCOPE_RULE_VERSION = 'quick-open-scope-v1'
const OWNERSHIP_KEY = 'local::disk-policy-root'

let temporaryDirectory: string | null = null

afterEach(async () => {
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
  temporaryDirectory = null
})

describe('workspace path checkpoint disk policy', () => {
  it('enables the resident re-encode only for the explicit opt-in value', () => {
    expect(workspacePathCatalogResidentCheckpointEncodeEnabled({})).toBe(false)
    expect(
      workspacePathCatalogResidentCheckpointEncodeEnabled({
        [WORKSPACE_PATH_CATALOG_CHECKPOINT_RESIDENT_ENCODE_ENV]: '0'
      })
    ).toBe(false)
    expect(
      workspacePathCatalogResidentCheckpointEncodeEnabled({
        [WORKSPACE_PATH_CATALOG_CHECKPOINT_RESIDENT_ENCODE_ENV]: 'true'
      })
    ).toBe(false)
    expect(
      workspacePathCatalogResidentCheckpointEncodeEnabled({
        [WORKSPACE_PATH_CATALOG_CHECKPOINT_RESIDENT_ENCODE_ENV]: '1'
      })
    ).toBe(true)
  })

  it('evicts whole checkpoints oldest first and keeps the newest', async () => {
    const fixture = await setUp()
    const older = workspacePathCatalogCheckpointIdentityHash('/root/older')
    const newer = workspacePathCatalogCheckpointIdentityHash('/root/newer')
    await writeRootCheckpoint(fixture, older, 'local::older', 'older')
    const newerBytes = await writeRootCheckpoint(fixture, newer, 'local::newer', 'newer')
    // Deterministic lifetime, not filesystem timestamp resolution.
    await age(join(fixture.checkpointRoot, older), 120_000)
    await age(join(fixture.checkpointRoot, newer), 60_000)

    // Room for exactly one of the two: the older checkpoint is the one evicted.
    expect(
      await pruneWorkspacePathCatalogCheckpointsToBudget(fixture.checkpointRoot, newerBytes + 1)
    ).toBe(true)
    expect(await readdir(fixture.checkpointRoot)).toEqual([newer])

    // Below even the survivor's own size the checkpoint root empties rather than keeping a
    // partially written root; eviction is by whole identity directory, never by file.
    expect(await pruneWorkspacePathCatalogCheckpointsToBudget(fixture.checkpointRoot, 1)).toBe(true)
    expect(await readdir(fixture.checkpointRoot)).toEqual([])
  })

  it('counts live spill bytes against the same cap and never reclaims them', async () => {
    const fixture = await setUp()
    const hash = workspacePathCatalogCheckpointIdentityHash('/root/resident-spill')
    await writeRootCheckpoint(fixture, hash, 'local::resident-spill', 'resident-spill')

    // Live spill bytes already exceed the cap: every checkpoint goes, then the caller is told the
    // write cannot fit. Dropping checkpoints never touches the spill directory it cannot see.
    expect(
      await pruneWorkspacePathCatalogCheckpointsToBudget(fixture.checkpointRoot, 4_096, 8_192)
    ).toBe(false)
    expect(await readdir(fixture.checkpointRoot)).toEqual([])
  })

  it('refuses a checkpoint the host cap cannot hold and leaves no manifest behind', async () => {
    const fixture = await setUp()
    const hash = workspacePathCatalogCheckpointIdentityHash('/root/over-cap')
    const directory = workspacePathCatalogCheckpointDirectory(fixture.checkpointRoot, hash)
    const written = await writeSpilledGeneration(fixture.spillDirectory, 'over-cap')

    await expect(
      writeWorkspacePathCatalogCheckpoint({
        checkpointDirectory: directory,
        ownershipKey: OWNERSHIP_KEY,
        generation: { catalog: written },
        hostBudgetBytes: 4_096,
        additionalResidentBytes: 8_192
      })
    ).rejects.toThrow('disk-cap')
    expect(await readWorkspacePathCatalogCheckpointManifest(directory)).toBeNull()
    expect(
      (await readdir(directory).catch(() => [])).filter((name) => name.endsWith('.wpc'))
    ).toEqual([])
  })
})

async function setUp(): Promise<{
  spillDirectory: string
  checkpointRoot: string
  source: WorkspacePathSpillRecord[]
}> {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'orca-checkpoint-policy-'))
  return {
    spillDirectory: join(temporaryDirectory, 'spill'),
    checkpointRoot: join(temporaryDirectory, 'checkpoints'),
    source: [
      { relativePath: 'src/item-10.ts', flags: 3 },
      { relativePath: 'src/item-2.ts', flags: 7 },
      { relativePath: 'src/nested/deep/item-1.ts', flags: 3 }
    ].sort((left, right) => compareFileNames(left.relativePath, right.relativePath))
  }
}

async function writeRootCheckpoint(
  fixture: { spillDirectory: string; checkpointRoot: string },
  identityHash: string,
  ownershipKey: string,
  generationId: string
): Promise<number> {
  const directory = workspacePathCatalogCheckpointDirectory(fixture.checkpointRoot, identityHash)
  const written = await writeSpilledGeneration(fixture.spillDirectory, generationId)
  await writeWorkspacePathCatalogCheckpoint({
    checkpointDirectory: directory,
    ownershipKey,
    generation: { catalog: written }
  })
  return measureDirectory(directory)
}

async function measureDirectory(directory: string): Promise<number> {
  let bytes = 0
  for (const name of await readdir(directory)) {
    bytes += (await stat(join(directory, name))).size
  }
  return bytes
}

async function writeSpilledGeneration(
  spillDirectory: string,
  generationId: string
): Promise<Extract<WorkspacePathCatalog, { storageKind: 'disk-spilled' }>> {
  const source = [
    { relativePath: 'src/item-10.ts', flags: 3 },
    { relativePath: 'src/item-2.ts', flags: 7 },
    { relativePath: 'src/nested/deep/item-1.ts', flags: 3 }
  ].sort((left, right) => compareFileNames(left.relativePath, right.relativePath))
  const written = await writeWorkspacePathCatalogSpill({
    directory: join(spillDirectory, generationId),
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
  if (written.catalog.storageKind !== 'disk-spilled') {
    throw new Error('Expected a disk-spilled catalog')
  }
  return written.catalog
}

async function age(directory: string, millisecondsAgo: number): Promise<void> {
  const aged = new Date(Date.now() - millisecondsAgo)
  for (const name of await readdir(directory)) {
    await utimes(join(directory, name), aged, aged)
  }
  await utimes(directory, aged, aged)
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
