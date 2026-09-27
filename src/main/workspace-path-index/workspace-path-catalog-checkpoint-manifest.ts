import { createHash } from 'node:crypto'
import type { WorkspacePathSearchOwnerIdentity } from '../../shared/workspace-path-search-contract'

export const WORKSPACE_PATH_CATALOG_CHECKPOINT_SCHEMA = 'workspace-path-catalog-checkpoint'
export const WORKSPACE_PATH_CATALOG_CHECKPOINT_SCHEMA_VERSION = 1
export const WORKSPACE_PATH_CATALOG_CHECKPOINT_MANIFEST_FILE = 'manifest.json'

/** Everything a restore needs in order to accept or reject a payload without opening it. */
export type WorkspacePathCatalogCheckpointManifest = {
  schema: typeof WORKSPACE_PATH_CATALOG_CHECKPOINT_SCHEMA
  schemaVersion: number
  blockFormatVersion: number
  identityHash: string
  payloadFile: string
  payloadBytes: number
  /** SHA-256 of the write-time ownership key, which the payload header also carries. */
  payloadIdentityHash: string
  generationId: string
  publishedScope: 'included' | 'all' | 'both'
  pathCount: number
  blockCount: number
  foldVersion: string
  foldLocale: string
  scopeRuleVersion: string
  writtenAtMilliseconds: number
}

/**
 * A checkpoint must survive a process restart, so its identity excludes the local provider's
 * incarnation — that is the OS pid. A remote incarnation still identifies which host produced the
 * bytes, so it stays in the key.
 */
export function workspacePathCatalogCheckpointIdentityKey(args: {
  owner: WorkspacePathSearchOwnerIdentity
  listingPolicyVersion: string
  foldVersion: string
  foldLocale: string
}): string {
  return JSON.stringify([
    args.owner.executionHost.provider,
    args.owner.executionHost.provider === 'local' ? null : args.owner.executionHost.incarnationId,
    args.owner.authorizedCanonicalRoot,
    WORKSPACE_PATH_CATALOG_CHECKPOINT_SCHEMA_VERSION,
    args.listingPolicyVersion,
    args.foldVersion,
    args.foldLocale
  ])
}

export function workspacePathCatalogCheckpointIdentityHash(identityKey: string): string {
  return createHash('sha256').update(identityKey).digest('hex')
}

/** Returns null for a torn, foreign-schema, or malformed manifest so callers treat it as absent. */
export function validateWorkspacePathCatalogCheckpointManifest(
  value: unknown
): WorkspacePathCatalogCheckpointManifest | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const schema = readString(value, 'schema')
  const schemaVersion = readCount(value, 'schemaVersion')
  const blockFormatVersion = readCount(value, 'blockFormatVersion')
  const identityHash = readString(value, 'identityHash')
  const payloadFile = readString(value, 'payloadFile')
  const payloadBytes = readCount(value, 'payloadBytes')
  const payloadIdentityHash = readString(value, 'payloadIdentityHash')
  const generationId = readString(value, 'generationId')
  const publishedScope = readScope(value, 'publishedScope')
  const pathCount = readCount(value, 'pathCount')
  const blockCount = readCount(value, 'blockCount')
  const foldVersion = readString(value, 'foldVersion')
  const foldLocale = readString(value, 'foldLocale')
  const scopeRuleVersion = readString(value, 'scopeRuleVersion')
  const writtenAtMilliseconds = readCount(value, 'writtenAtMilliseconds')
  if (
    schema !== WORKSPACE_PATH_CATALOG_CHECKPOINT_SCHEMA ||
    schemaVersion !== WORKSPACE_PATH_CATALOG_CHECKPOINT_SCHEMA_VERSION ||
    blockFormatVersion !== 1 ||
    !identityHash ||
    !payloadFile ||
    payloadBytes === null ||
    !payloadIdentityHash ||
    !generationId ||
    !publishedScope ||
    pathCount === null ||
    blockCount === null ||
    blockCount > pathCount + 1 ||
    (pathCount === 0) !== (blockCount === 0) ||
    !foldVersion ||
    !foldLocale ||
    !scopeRuleVersion ||
    writtenAtMilliseconds === null
  ) {
    return null
  }
  // A payload path is a same-directory basename; anything else is a forged or corrupt manifest.
  if (payloadFile.includes('/') || payloadFile.includes('\\') || payloadFile.startsWith('.')) {
    return null
  }
  return {
    schema,
    schemaVersion,
    blockFormatVersion,
    identityHash,
    payloadFile,
    payloadBytes,
    payloadIdentityHash,
    generationId,
    publishedScope,
    pathCount,
    blockCount,
    foldVersion,
    foldLocale,
    scopeRuleVersion,
    writtenAtMilliseconds
  }
}

function readString(source: unknown, key: string): string | null {
  if (!isManifestFieldSource(source) || !(key in source)) {
    return null
  }
  const value = source[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readCount(source: unknown, key: string): number | null {
  if (!isManifestFieldSource(source) || !(key in source)) {
    return null
  }
  const value = source[key]
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function readScope(
  source: unknown,
  key: string
): WorkspacePathCatalogCheckpointManifest['publishedScope'] | null {
  const value = readString(source, key)
  return value === 'included' || value === 'all' || value === 'both' ? value : null
}

/** The manifest is parsed from a file, so fields are read off an unknown record at that boundary. */
function isManifestFieldSource(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
