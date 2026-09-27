import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { durableWriteTempPath, renameDurable, writeTempFileDurable } from '../durable-file-write'
import {
  WORKSPACE_PATH_CATALOG_CHECKPOINT_MANIFEST_FILE,
  type WorkspacePathCatalogCheckpointManifest,
  validateWorkspacePathCatalogCheckpointManifest
} from './workspace-path-catalog-checkpoint-manifest'

/**
 * Per-identity checkpoint ceiling. One generation is retained per root, so this bounds a single
 * root's payload: the measured 1M-adversarial worst case is 566 MB, leaving ~35% headroom before a
 * root is refused. A checkpoint is an optimization, so refusing one only costs a provisional page.
 */
export const WORKSPACE_PATH_CATALOG_CHECKPOINT_ROOT_DISK_BUDGET_BYTES = 768 * 1024 * 1024

/**
 * Host-wide ceiling shared by every checkpoint and this process's live spill directory. It reuses
 * the spill root's existing 4 GiB number instead of introducing a second, unrelated one.
 */
export const WORKSPACE_PATH_CATALOG_CHECKPOINT_HOST_DISK_BUDGET_BYTES = 4 * 1024 * 1024 * 1024

/** One directory per checkpoint identity; the directory name is the identity hash. */
export function workspacePathCatalogCheckpointDirectory(
  rootDirectory: string,
  identityHash: string
): string {
  return join(rootDirectory, identityHash)
}

export function workspacePathCatalogCheckpointPayloadPath(
  checkpointDirectory: string,
  payloadFile: string
): string {
  return join(checkpointDirectory, payloadFile)
}

/** A missing, torn, foreign-schema, or mismatched manifest is absent, never an error to handle. */
export async function readWorkspacePathCatalogCheckpointManifest(
  checkpointDirectory: string
): Promise<WorkspacePathCatalogCheckpointManifest | null> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(
        join(checkpointDirectory, WORKSPACE_PATH_CATALOG_CHECKPOINT_MANIFEST_FILE),
        'utf8'
      )
    )
    const manifest = validateWorkspacePathCatalogCheckpointManifest(parsed)
    if (!manifest || manifest.identityHash !== basename(checkpointDirectory)) {
      return null
    }
    const payload = await stat(
      workspacePathCatalogCheckpointPayloadPath(checkpointDirectory, manifest.payloadFile)
    )
    return payload.isFile() && payload.size === manifest.payloadBytes ? manifest : null
  } catch {
    return null
  }
}

/**
 * Publishes the manifest last, so a crash mid-write leaves either the previous checkpoint or none —
 * never a manifest pointing at a partial payload.
 */
export async function publishWorkspacePathCatalogCheckpoint(
  checkpointDirectory: string,
  manifest: WorkspacePathCatalogCheckpointManifest
): Promise<void> {
  await mkdir(checkpointDirectory, { recursive: true, mode: 0o700 })
  const manifestPath = join(checkpointDirectory, WORKSPACE_PATH_CATALOG_CHECKPOINT_MANIFEST_FILE)
  const tempPath = durableWriteTempPath(manifestPath)
  await writeTempFileDurable(tempPath, `${JSON.stringify(manifest)}\n`, 0o600)
  await renameDurable(tempPath, manifestPath)
}

/** Removes payload files the current manifest does not reference: only one generation is retained. */
export async function pruneWorkspacePathCatalogCheckpointGenerations(
  checkpointDirectory: string,
  retainedPayloadFile: string
): Promise<number> {
  let removed = 0
  for (const name of await readdir(checkpointDirectory).catch((): string[] => [])) {
    if (name.endsWith('.wpc') && name !== retainedPayloadFile) {
      await rm(join(checkpointDirectory, name), { force: true }).catch(() => undefined)
      removed += 1
    }
  }
  return removed
}

/** Deletes a root's checkpoint when authorization is revoked: filenames are sensitive data. */
export async function removeWorkspacePathCatalogCheckpoint(
  checkpointDirectory: string
): Promise<void> {
  await rm(checkpointDirectory, { recursive: true, force: true })
}

/**
 * Enforces the host budget over checkpoints plus any live spill bytes counted against the same cap,
 * dropping whole checkpoints oldest first. Eviction order matters: a checkpoint is a rebuildable
 * optimization, while a live spill may be pinned by an in-flight scan, so checkpoints go first and
 * a spill is never touched here. Returns whether the combined total now fits the budget.
 */
export async function pruneWorkspacePathCatalogCheckpointsToBudget(
  rootDirectory: string,
  budgetBytes = WORKSPACE_PATH_CATALOG_CHECKPOINT_HOST_DISK_BUDGET_BYTES,
  additionalResidentBytes = 0
): Promise<boolean> {
  const measured = await measureCheckpointDirectories(rootDirectory)
  let totalBytes = additionalResidentBytes
  for (const entry of measured) {
    totalBytes += entry.bytes
  }
  if (totalBytes <= budgetBytes) {
    return true
  }
  measured.sort((left, right) => left.modifiedAt - right.modifiedAt)
  for (const candidate of measured) {
    if (totalBytes <= budgetBytes) {
      break
    }
    await rm(join(rootDirectory, candidate.name), {
      recursive: true,
      force: true
    }).catch(() => undefined)
    totalBytes -= candidate.bytes
  }
  return totalBytes <= budgetBytes
}

/**
 * Makes room for one checkpoint before it is written, so a refused checkpoint never lands. Evicting
 * oldest-first is what keeps a new root from being starved by an old one, and the marginal cost is
 * zero when the payload hardlinks a spill file that this process already pays for.
 */
export async function reserveWorkspacePathCatalogCheckpointDiskBudget(args: {
  rootDirectory: string
  hostBudgetBytes: number
  additionalResidentBytes: number
  marginalBytes: number
}): Promise<boolean> {
  return pruneWorkspacePathCatalogCheckpointsToBudget(
    args.rootDirectory,
    args.hostBudgetBytes - args.marginalBytes,
    args.additionalResidentBytes
  )
}

async function measureCheckpointDirectories(
  rootDirectory: string
): Promise<{ name: string; bytes: number; modifiedAt: number }[]> {
  const measured: { name: string; bytes: number; modifiedAt: number }[] = []
  for (const entry of await readdir(rootDirectory, {
    withFileTypes: true
  }).catch(() => [])) {
    if (entry.isDirectory()) {
      const size = await measureDirectoryBytes(join(rootDirectory, entry.name))
      measured.push({
        name: entry.name,
        bytes: size.bytes,
        modifiedAt: size.modifiedAt
      })
    }
  }
  return measured
}

/** Sums every checkpoint directory so a write can decide whether the host budget has room. */
export async function measureWorkspacePathCatalogCheckpointRootBytes(
  rootDirectory: string
): Promise<number> {
  let total = 0
  for (const entry of await measureCheckpointDirectories(rootDirectory)) {
    total += entry.bytes
  }
  return total
}

async function measureDirectoryBytes(
  directory: string
): Promise<{ bytes: number; modifiedAt: number }> {
  let bytes = 0
  let modifiedAt = 0
  for (const name of await readdir(directory).catch((): string[] => [])) {
    try {
      const entry = await stat(join(directory, name))
      bytes += entry.size
      modifiedAt = Math.max(modifiedAt, entry.mtimeMs)
    } catch {
      // A concurrently removed payload does not change the budget decision.
    }
  }
  return { bytes, modifiedAt }
}
