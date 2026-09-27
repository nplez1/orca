/** Env switch for the resident re-encode; unset means the expensive form is off (plan §7). */
export const WORKSPACE_PATH_CATALOG_CHECKPOINT_RESIDENT_ENCODE_ENV =
  'ORCA_PATH_INDEX_CHECKPOINT_RESIDENT'

/**
 * Why: a resident catalog costs a compaction plus a re-encode (34–45% of a build) while a spilled one
 * hardlinks for free, and a resident root is small enough that the rebuild is short.
 */
export function workspacePathCatalogResidentCheckpointEncodeEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return env[WORKSPACE_PATH_CATALOG_CHECKPOINT_RESIDENT_ENCODE_ENV] === '1'
}
