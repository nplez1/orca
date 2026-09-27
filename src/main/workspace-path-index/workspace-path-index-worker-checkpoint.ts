import {
  WORKSPACE_PATH_CATALOG_FOLD_VERSION,
  WORKSPACE_PATH_CATALOG_SCOPE_RULE_VERSION,
  resolveWorkspacePathFoldLocale,
  type WorkspacePathCatalogGeneration
} from '../../shared/workspace-path-catalog'
import { compactWorkspacePathCatalogGenerationInWorker } from '../../shared/workspace-path-catalog-compaction-worker'
import { directorySizeBytes } from './workspace-path-catalog-spill-runs-disk-budget'
import { workspacePathCatalogResidentCheckpointEncodeEnabled } from './workspace-path-catalog-checkpoint-policy'
import { restoreWorkspacePathCatalogCheckpoint } from './workspace-path-catalog-checkpoint-restore'
import {
  WorkspacePathCatalogCheckpointSkippedError,
  workspacePathCatalogCheckpointPublishedScope,
  writeWorkspacePathCatalogCheckpoint
} from './workspace-path-catalog-checkpoint-writer'
import type {
  WorkspacePathIndexWorkerRequest,
  WorkspacePathIndexWorkerResponse
} from './workspace-path-index-worker-protocol'
import {
  publishWorkspacePathIndexWorkerGeneration,
  workspacePathIndexWorkerGenerationKey
} from './workspace-path-index-worker-generation'

type CheckpointRequest = Extract<
  WorkspacePathIndexWorkerRequest,
  { type: 'restore-checkpoint' | 'write-checkpoint' }
>

/**
 * Checkpoint work stays in the worker: a restore constructs the catalog here, and a write merges and
 * re-encodes a base-plus-delta generation here. Neither ever runs on the main thread.
 */
export async function handleWorkspacePathIndexCheckpointRequest(
  request: CheckpointRequest,
  generations: Map<string, WorkspacePathCatalogGeneration>,
  latestGenerationIds: Map<string, string>
): Promise<WorkspacePathIndexWorkerResponse> {
  try {
    return request.type === 'restore-checkpoint'
      ? await restoreCheckpoint(request, generations, latestGenerationIds)
      : await writeCheckpoint(request, generations)
  } catch (error) {
    return {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : 'Workspace path index checkpoint failed.'
    }
  }
}

async function restoreCheckpoint(
  request: Extract<CheckpointRequest, { type: 'restore-checkpoint' }>,
  generations: Map<string, WorkspacePathCatalogGeneration>,
  latestGenerationIds: Map<string, string>
): Promise<WorkspacePathIndexWorkerResponse> {
  // The execution host validates against the folding and scope rule it resolved for itself.
  const outcome = await restoreWorkspacePathCatalogCheckpoint({
    checkpointDirectory: request.checkpointDirectory,
    expectedFoldVersion: WORKSPACE_PATH_CATALOG_FOLD_VERSION,
    expectedFoldLocale: resolveWorkspacePathFoldLocale(),
    expectedScopeRuleVersion: WORKSPACE_PATH_CATALOG_SCOPE_RULE_VERSION
  })
  if (!outcome.restored) {
    return {
      id: request.id,
      ok: true,
      checkpoint: { status: 'absent', reason: outcome.reason }
    }
  }
  const { generation, manifest, loadMilliseconds, directoryValidationMilliseconds } = outcome.result
  // Marked here, and only here: a restored snapshot is last-known, so its queries stay bounded
  // until reconciliation publishes a fresh generation. A spilled catalog that was written by this
  // session (a spill, not a restore) keeps exact-count semantics.
  publishWorkspacePathIndexWorkerGeneration({
    generations,
    latestGenerationIds,
    rootKey: request.key,
    generationId: manifest.generationId,
    generation: { ...generation, provisionalLastKnown: true }
  })
  return {
    id: request.id,
    ok: true,
    checkpoint: {
      status: 'restored',
      generationId: manifest.generationId,
      publishedScope: manifest.publishedScope,
      retainedBytes: generation.catalog.retainedBytes,
      pathCount: manifest.pathCount,
      loadMilliseconds,
      directoryValidationMilliseconds
    }
  }
}

async function writeCheckpoint(
  request: Extract<CheckpointRequest, { type: 'write-checkpoint' }>,
  generations: Map<string, WorkspacePathCatalogGeneration>
): Promise<WorkspacePathIndexWorkerResponse> {
  const stored = generations.get(
    workspacePathIndexWorkerGenerationKey(request.key, request.generationId)
  )
  if (!stored) {
    return {
      id: request.id,
      ok: true,
      checkpoint: { status: 'absent', reason: 'absent' }
    }
  }
  // Policy gate before the expensive work: a resident catalog is only re-encoded on explicit opt-in,
  // so the default must not pay for the compaction that only the re-encode needs.
  if (
    stored.catalog.storageKind !== 'disk-spilled' &&
    !workspacePathCatalogResidentCheckpointEncodeEnabled()
  ) {
    return {
      id: request.id,
      ok: true,
      checkpoint: { status: 'absent', reason: 'resident-encoder-disabled' }
    }
  }
  // A base-plus-delta generation is not a checkpoint unit: merge it into one snapshot first.
  const materialized = await compactWorkspacePathCatalogGenerationInWorker(stored, {
    generationId: `${stored.catalog.generationId}:checkpoint`,
    maxBytes: request.maxBytes
  })
  const generation = materialized ?? stored
  if (generation.overlay) {
    return {
      id: request.id,
      ok: true,
      checkpoint: { status: 'absent', reason: 'delta-pending' }
    }
  }
  // Coverage comes from the catalog itself: a caller-supplied scope could persist a half-built
  // snapshot as a complete checkpoint.
  if (!workspacePathCatalogCheckpointPublishedScope(generation.catalog.metadata)) {
    return {
      id: request.id,
      ok: true,
      checkpoint: { status: 'absent', reason: 'scope-incomplete' }
    }
  }
  let written: Awaited<ReturnType<typeof writeWorkspacePathCatalogCheckpoint>>
  try {
    written = await writeWorkspacePathCatalogCheckpoint({
      checkpointDirectory: request.checkpointDirectory,
      ownershipKey: request.key,
      generation,
      // Live spill files share the host disk cap with checkpoints; they are never reclaimed here.
      additionalResidentBytes: request.spillDirectory
        ? await directorySizeBytes(request.spillDirectory).catch(() => 0)
        : 0
    })
  } catch (error) {
    if (error instanceof WorkspacePathCatalogCheckpointSkippedError) {
      return {
        id: request.id,
        ok: true,
        checkpoint: { status: 'absent', reason: error.skipReason }
      }
    }
    throw error
  }
  return {
    id: request.id,
    ok: true,
    checkpoint: {
      status: 'written',
      payloadBytes: written.payloadBytes,
      writeMilliseconds: written.writeMilliseconds,
      reusedSpillFile: written.reusedSpillFile
    }
  }
}
