import { copyFile, link, mkdir, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  WorkspacePathCatalogGeneration,
  WorkspacePathCatalogMetadata
} from '../../shared/workspace-path-catalog'
import { readWorkspacePathCatalogSpillHeader } from './workspace-path-catalog-spill'
import { WorkspacePathCatalogSpillRuns } from './workspace-path-catalog-spill-runs'
import {
  WORKSPACE_PATH_CATALOG_CHECKPOINT_SCHEMA,
  WORKSPACE_PATH_CATALOG_CHECKPOINT_SCHEMA_VERSION,
  type WorkspacePathCatalogCheckpointManifest
} from './workspace-path-catalog-checkpoint-manifest'
import {
  WORKSPACE_PATH_CATALOG_CHECKPOINT_HOST_DISK_BUDGET_BYTES,
  WORKSPACE_PATH_CATALOG_CHECKPOINT_ROOT_DISK_BUDGET_BYTES,
  measureWorkspacePathCatalogCheckpointRootBytes as measureCheckpointRootBytes,
  pruneWorkspacePathCatalogCheckpointGenerations,
  publishWorkspacePathCatalogCheckpoint,
  reserveWorkspacePathCatalogCheckpointDiskBudget,
  workspacePathCatalogCheckpointPayloadPath
} from './workspace-path-catalog-checkpoint-store'
import { workspacePathCatalogResidentCheckpointEncodeEnabled } from './workspace-path-catalog-checkpoint-policy'

export function workspacePathCatalogCheckpointPublishedScope(
  metadata: WorkspacePathCatalogMetadata
): 'included' | 'all' | 'both' | null {
  if (metadata.includedComplete && metadata.allComplete) {
    return 'both'
  }
  if (metadata.includedComplete) {
    return 'included'
  }
  return metadata.allComplete ? 'all' : null
}

export type WorkspacePathCatalogCheckpointWriteResult = {
  payloadBytes: number
  writeMilliseconds: number
  reusedSpillFile: boolean
}

export type WorkspacePathCatalogCheckpointWriteSkipReason =
  | 'resident-encoder-disabled'
  | 'disk-budget'
  | 'disk-cap'

/**
 * Persists one completed generation as a checkpoint. Runs in the build worker: a resident catalog is
 * re-encoded in the build lane's spill form, never deserialized or encoded on the main thread.
 */
export async function writeWorkspacePathCatalogCheckpoint(args: {
  checkpointDirectory: string
  ownershipKey: string
  generation: WorkspacePathCatalogGeneration
  /** Per-identity ceiling for this root's payload. */
  perRootBudgetBytes?: number
  /** Host-wide ceiling shared by every checkpoint and the caller's live spill bytes. */
  hostBudgetBytes?: number
  /** Live spill bytes counted against the same host cap; the caller owns measuring them. */
  additionalResidentBytes?: number
  /** Defaults to the host policy: a resident catalog is only re-encoded on explicit opt-in. */
  residentEncodeEnabled?: boolean
}): Promise<WorkspacePathCatalogCheckpointWriteResult> {
  const startedAt = performance.now()
  const perRootBudgetBytes =
    args.perRootBudgetBytes ?? WORKSPACE_PATH_CATALOG_CHECKPOINT_ROOT_DISK_BUDGET_BYTES
  const hostBudgetBytes =
    args.hostBudgetBytes ?? WORKSPACE_PATH_CATALOG_CHECKPOINT_HOST_DISK_BUDGET_BYTES
  const residentEncodeEnabled =
    args.residentEncodeEnabled ?? workspacePathCatalogResidentCheckpointEncodeEnabled()
  // Coverage comes from the catalog, never from a caller claim: a half-built snapshot must not be
  // persisted as a complete checkpoint.
  const publishedScope = workspacePathCatalogCheckpointPublishedScope(
    args.generation.catalog.metadata
  )
  if (!publishedScope) {
    throw new Error('Workspace path catalog checkpoint requires a complete snapshot')
  }
  const directory = args.checkpointDirectory
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const payloadFile = `${args.generation.catalog.generationId}.wpc`
  const payloadPath = workspacePathCatalogCheckpointPayloadPath(directory, payloadFile)
  const catalog = args.generation.catalog
  // Marginal bytes are 0 for a hardlink (it shares the spill inode) and the resident upper bound
  // otherwise, so the host cap measures what this checkpoint actually adds.
  const marginalBytes = catalog.storageKind === 'disk-spilled' ? 0 : catalog.retainedBytes
  const withinHostBudget = await reserveWorkspacePathCatalogCheckpointDiskBudget({
    rootDirectory: dirname(directory),
    hostBudgetBytes,
    additionalResidentBytes: args.additionalResidentBytes ?? 0,
    marginalBytes
  })
  if (!withinHostBudget) {
    // Live spills already spend the cap and must not be reclaimed, so the honest outcome is no
    // checkpoint: this root keeps the live-scan/rebuild path and simply has no provisional page.
    throw new WorkspacePathCatalogCheckpointSkippedError('disk-cap')
  }
  let reusedSpillFile = false
  if (catalog.storageKind === 'disk-spilled') {
    // A hardlink is the spill inode itself, so it adds no storage and always fits when the root does.
    if ((await stat(catalog.spillFilePath)).size > perRootBudgetBytes) {
      throw new WorkspacePathCatalogCheckpointSkippedError('disk-budget')
    }
    reusedSpillFile = await linkOrCopy(catalog.spillFilePath, payloadPath)
  } else if (!residentEncodeEnabled) {
    throw new WorkspacePathCatalogCheckpointSkippedError('resident-encoder-disabled')
  } else if (await canEncodeResidentCatalogPayload(directory, catalog, perRootBudgetBytes)) {
    if (!(await encodeResidentCatalogPayload(args.ownershipKey, directory, catalog, payloadPath))) {
      throw new Error('Workspace path catalog checkpoint encoding failed')
    }
  } else {
    throw new WorkspacePathCatalogCheckpointSkippedError('disk-budget')
  }
  const header = await readWorkspacePathCatalogSpillHeader(payloadPath)
  const payloadBytes = (await stat(payloadPath)).size
  const manifest: WorkspacePathCatalogCheckpointManifest = {
    schema: WORKSPACE_PATH_CATALOG_CHECKPOINT_SCHEMA,
    schemaVersion: WORKSPACE_PATH_CATALOG_CHECKPOINT_SCHEMA_VERSION,
    blockFormatVersion: header.blockFormatVersion,
    identityHash: basename(directory),
    payloadFile,
    payloadBytes,
    payloadIdentityHash: header.identityHash,
    generationId: header.generationId,
    publishedScope,
    pathCount: header.pathCount,
    blockCount: header.blockCount,
    foldVersion: header.foldVersion,
    foldLocale: header.foldLocale,
    scopeRuleVersion: header.scopeRuleVersion,
    writtenAtMilliseconds: Date.now()
  }
  await publishWorkspacePathCatalogCheckpoint(directory, manifest)
  await pruneWorkspacePathCatalogCheckpointGenerations(directory, payloadFile)
  return {
    payloadBytes,
    writeMilliseconds: performance.now() - startedAt,
    reusedSpillFile
  }
}

/**
 * Whether the resident re-encode has room inside this root's own ceiling. A spilled generation
 * checkpoints by hardlinking a file that already exists, so it needs no encode-room check.
 */
async function canEncodeResidentCatalogPayload(
  directory: string,
  catalog: Exclude<WorkspacePathCatalogGeneration['catalog'], { storageKind: 'disk-spilled' }>,
  perRootBudgetBytes: number
): Promise<boolean> {
  const retained = await measureCheckpointRootBytes(dirname(directory))
  // The resident form is a conservative upper bound for the encoded payload.
  return retained + catalog.retainedBytes <= perRootBudgetBytes
}

export class WorkspacePathCatalogCheckpointSkippedError extends Error {
  constructor(readonly skipReason: WorkspacePathCatalogCheckpointWriteSkipReason) {
    super(`Workspace path catalog checkpoint skipped: ${skipReason}`)
  }
}

/** Link keeps a same-filesystem checkpoint nearly free; copy covers volumes without hardlinks. */
async function linkOrCopy(sourcePath: string, targetPath: string): Promise<boolean> {
  await rm(targetPath, { force: true }).catch(() => undefined)
  try {
    await link(sourcePath, targetPath)
    return true
  } catch {
    await copyFile(sourcePath, targetPath)
    return false
  }
}

/**
 * Re-encodes a resident catalog through the bounded run merge, into a staging directory, then moves
 * the finished payload into place. The live resident catalog is left untouched.
 */
async function encodeResidentCatalogPayload(
  ownershipKey: string,
  checkpointDirectory: string,
  catalog: Exclude<WorkspacePathCatalogGeneration['catalog'], { storageKind: 'disk-spilled' }>,
  payloadPath: string
): Promise<boolean> {
  const stagingDirectory = join(checkpointDirectory, `staging-${randomUUID()}`)
  const runs = new WorkspacePathCatalogSpillRuns(
    stagingDirectory,
    ownershipKey,
    catalog.generationId,
    undefined,
    dirname(checkpointDirectory)
  )
  try {
    if (!(await runs.seedCatalog('included', catalog))) {
      return false
    }
    const finished = await runs.finishAllScopes('all', catalog.generationId, catalog.metadata)
    if (!finished || finished.catalog.storageKind !== 'disk-spilled') {
      return false
    }
    await rm(payloadPath, { force: true }).catch(() => undefined)
    await rename(finished.catalog.spillFilePath, payloadPath)
    return true
  } finally {
    await runs.cleanupScratch().catch(() => undefined)
    await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined)
  }
}
