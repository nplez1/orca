import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  resolveWorkspacePathFoldLocale,
  type WorkspacePathCatalogGeneration,
  type WorkspacePathCatalogMetadata
} from '../../shared/workspace-path-catalog'
import { writeWorkspacePathCatalogSpill } from './workspace-path-catalog-spill'
import { pinnedWorkspacePathCatalogCheckpoints } from './workspace-path-catalog-checkpoint-store'
import {
  dropWorkspacePathIndexWorkerGeneration,
  publishWorkspacePathIndexWorkerGeneration
} from './workspace-path-index-worker-generation'
import {
  pinRestoredWorkspacePathCheckpoint,
  resetRestoredWorkspacePathCheckpointPinsForTests
} from './workspace-path-index-worker-checkpoint-pins'

/**
 * Why this file exists: the pin's release has to be decided from what the worker still reads, and
 * only the generation map knows that. A spilled delta on a restored catalog writes its replacement
 * spill into the same checkpoint directory, so publishing or dropping *that* generation must not
 * unpin the directory the restored one is still being served from.
 */

const FOLD_VERSION = 'locale-lowercase-v1'
const SCOPE_RULE_VERSION = 'quick-open-scope-v1'
const ROOT_KEY = 'local::restored-root'

let temporaryDirectory: string | null = null

afterEach(async () => {
  resetRestoredWorkspacePathCheckpointPinsForTests()
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
  temporaryDirectory = null
})

async function checkpointDirectory(): Promise<string> {
  temporaryDirectory ??= await mkdtemp(join(tmpdir(), 'orca-checkpoint-pin-'))
  return join(temporaryDirectory, 'identity-hash')
}

async function spilledGeneration(
  directory: string,
  generationId: string
): Promise<WorkspacePathCatalogGeneration> {
  const written = await writeWorkspacePathCatalogSpill({
    directory,
    identityKey: ROOT_KEY,
    generationId,
    metadata: metadata(),
    pathCount: 1,
    records: {
      async *[Symbol.asyncIterator]() {
        yield { relativePath: 'src/only.ts', flags: 3 }
      }
    }
  })
  return { catalog: written.catalog }
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

function pinned(): readonly string[] {
  return pinnedWorkspacePathCatalogCheckpoints()
}

describe('restored checkpoint pins through the generation map', () => {
  it('keeps the pin while the restored generation is retained, and releases it on its drop', async () => {
    const directory = await checkpointDirectory()
    const generations = new Map<string, WorkspacePathCatalogGeneration>()
    const latestGenerationIds = new Map<string, string>()
    const restored = await spilledGeneration(directory, 'generation-restored')
    pinRestoredWorkspacePathCheckpoint({
      rootKey: ROOT_KEY,
      checkpointDirectory: directory,
      generationId: 'generation-restored'
    })

    publishWorkspacePathIndexWorkerGeneration({
      generations,
      latestGenerationIds,
      rootKey: ROOT_KEY,
      generationId: 'generation-restored',
      generation: restored
    })
    // A restore's own publish must not drop the pin it just took.
    expect(pinned()).toEqual([directory])

    // A spilled delta in the same directory: publishing it must not unpin either.
    const delta = await spilledGeneration(directory, 'generation-delta')
    publishWorkspacePathIndexWorkerGeneration({
      generations,
      latestGenerationIds,
      rootKey: ROOT_KEY,
      generationId: 'generation-delta',
      generation: delta
    })
    expect(pinned()).toEqual([directory])

    // Dropping the rejected delta leaves the restored generation served from that directory.
    dropWorkspacePathIndexWorkerGeneration({
      generations,
      latestGenerationIds,
      rootKey: ROOT_KEY,
      generationId: 'generation-delta'
    })
    expect(pinned()).toEqual([directory])

    dropWorkspacePathIndexWorkerGeneration({
      generations,
      latestGenerationIds,
      rootKey: ROOT_KEY,
      generationId: 'generation-restored'
    })
    expect(pinned()).toEqual([])
  })
})
