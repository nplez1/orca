import {
  workspacePathCatalogRetainedBytes,
  type WorkspacePathCatalog,
  type WorkspacePathCatalogGeneration
} from '../../shared/workspace-path-catalog'
import {
  SPILL_DIRECTORY_ENTRY_BYTES,
  SPILL_HEADER_RESERVE_BYTES,
  readWorkspacePathCatalogSpillHeader,
  type WorkspacePathSpillHeader
} from './workspace-path-catalog-spill'
import type { WorkspacePathCatalogCheckpointManifest } from './workspace-path-catalog-checkpoint-manifest'
import { validateWorkspacePathCatalogCheckpointPayloadDirectory } from './workspace-path-catalog-checkpoint-payload-validation'
import {
  readWorkspacePathCatalogCheckpointManifest,
  workspacePathCatalogCheckpointPayloadPath
} from './workspace-path-catalog-checkpoint-store'

const SPILL_MAGIC_BYTES = 8

export type WorkspacePathCatalogCheckpointRestore = {
  generation: WorkspacePathCatalogGeneration
  manifest: WorkspacePathCatalogCheckpointManifest
  loadMilliseconds: number
  directoryValidationMilliseconds: number
}

export type WorkspacePathCatalogCheckpointRestoreRejection =
  | 'absent'
  | 'identity-mismatch'
  | 'fold-mismatch'
  | 'policy-mismatch'
  | 'payload-invalid'

export type WorkspacePathCatalogCheckpointRestoreOutcome =
  | { restored: true; result: WorkspacePathCatalogCheckpointRestore }
  | { restored: false; reason: WorkspacePathCatalogCheckpointRestoreRejection }

/**
 * Loads a checkpoint for a cold root. Every failure — missing, torn, foreign root, changed folding
 * or listing policy, or a payload whose header disagrees with its manifest — is an absence, because
 * an active root's correctness must never depend on checkpoint success.
 */
export async function restoreWorkspacePathCatalogCheckpoint(args: {
  checkpointDirectory: string
  expectedFoldVersion: string
  expectedFoldLocale: string
  /** Listing policy is already part of the identity hash; the scope rule is a separate check. */
  expectedScopeRuleVersion: string
}): Promise<WorkspacePathCatalogCheckpointRestoreOutcome> {
  const startedAt = performance.now()
  const manifest = await readWorkspacePathCatalogCheckpointManifest(args.checkpointDirectory)
  if (!manifest) {
    return { restored: false, reason: 'absent' }
  }
  if (
    manifest.foldVersion !== args.expectedFoldVersion ||
    manifest.foldLocale !== args.expectedFoldLocale
  ) {
    return { restored: false, reason: 'fold-mismatch' }
  }
  if (manifest.scopeRuleVersion !== args.expectedScopeRuleVersion) {
    return { restored: false, reason: 'policy-mismatch' }
  }
  const payloadPath = workspacePathCatalogCheckpointPayloadPath(
    args.checkpointDirectory,
    manifest.payloadFile
  )
  let header: WorkspacePathSpillHeader
  try {
    header = await readWorkspacePathCatalogSpillHeader(payloadPath)
  } catch {
    return { restored: false, reason: 'payload-invalid' }
  }
  if (
    header.identityHash !== manifest.payloadIdentityHash ||
    header.generationId !== manifest.generationId ||
    header.pathCount !== manifest.pathCount ||
    header.blockCount !== manifest.blockCount ||
    header.blockFormatVersion !== manifest.blockFormatVersion ||
    header.foldVersion !== manifest.foldVersion ||
    header.foldLocale !== manifest.foldLocale ||
    header.scopeRuleVersion !== manifest.scopeRuleVersion ||
    header.metadata.scopeRuleVersion !== args.expectedScopeRuleVersion
  ) {
    return { restored: false, reason: 'payload-invalid' }
  }
  const catalog = buildCheckpointCatalog(manifest, header, payloadPath)
  const validationStartedAt = performance.now()
  const directoryValid = await validateWorkspacePathCatalogCheckpointPayloadDirectory({
    payloadPath,
    directoryOffset: catalog.spillDirectoryOffset,
    dataOffset: catalog.spillDataOffset,
    pathCount: catalog.pathCount,
    blockCount: catalog.spillBlockCount
  })
  const directoryValidationMilliseconds = performance.now() - validationStartedAt
  if (!directoryValid) {
    return { restored: false, reason: 'payload-invalid' }
  }
  return {
    restored: true,
    result: {
      generation: { catalog },
      manifest,
      loadMilliseconds: performance.now() - startedAt,
      directoryValidationMilliseconds
    }
  }
}

/**
 * The spilled read path supplies paths and flags from decoded blocks, so the offset and flag arrays
 * here exist to keep the catalog's shape and retained-byte accounting identical to a written one.
 */
function buildCheckpointCatalog(
  manifest: WorkspacePathCatalogCheckpointManifest,
  header: WorkspacePathSpillHeader,
  payloadPath: string
): Extract<WorkspacePathCatalog, { storageKind: 'disk-spilled' }> {
  const pathCount = header.pathCount
  const naturalOrder = new Uint32Array(pathCount)
  for (let rank = 0; rank < pathCount; rank += 1) {
    naturalOrder[rank] = rank
  }
  const originalOffsets = new Uint32Array(pathCount + 1)
  const foldedOffsets = new Uint32Array(pathCount + 1)
  const flags = new Uint8Array(pathCount)
  const directoryOffset = SPILL_MAGIC_BYTES + 4 + SPILL_HEADER_RESERVE_BYTES
  return {
    generationId: manifest.generationId,
    metadata: header.metadata,
    pathCount,
    originalOffsets,
    foldedOffsets,
    naturalOrder,
    flags,
    retainedBytes: workspacePathCatalogRetainedBytes(
      0,
      foldedOffsets,
      naturalOrder,
      flags,
      originalOffsets,
      { kind: 'disk-spilled' }
    ),
    storageKind: 'disk-spilled',
    spillFilePath: payloadPath,
    spillIdentityKey: header.identityHash,
    spillHeaderBytes: SPILL_HEADER_RESERVE_BYTES,
    spillDirectoryOffset: directoryOffset,
    spillDirectoryCapacity: header.directoryCapacity,
    spillDataOffset: directoryOffset + header.directoryCapacity * SPILL_DIRECTORY_ENTRY_BYTES,
    spillBlockCount: header.blockCount
  }
}
