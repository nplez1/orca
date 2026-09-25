import { lstat, realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  WorktreeLinkedPathTargetExistsError,
  type DarwinFilesystemCache
} from './worktree-apfs-clone'
import {
  createWorktreeCopyBudgetTracker,
  type SkippedWorktreeCopyPath
} from './worktree-include-copy-budget'
import {
  copyIsCopyOnWrite,
  createWorktreeLinkedPath,
  WorktreeCopyBudgetFallbackError,
  type WorktreeLinkedPathOptions,
  type WorktreeMaterializeMode
} from './worktree-path-publisher'
import { targetExists } from './worktree-materialization-staging'
import { getSafeRelativePath } from '../git/worktree-symlink-detection'

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

export async function materializeWorktreePaths(
  primaryPath: string,
  worktreePath: string,
  paths: readonly string[],
  mode: WorktreeMaterializeMode,
  options: WorktreeLinkedPathOptions = {},
  allowUnboundedCopyFallback = false,
  materializationFailures?: string[]
): Promise<SkippedWorktreeCopyPath[]> {
  const effectiveOptions = { platform: process.platform, ...options }
  const apfsFilesystemCache: DarwinFilesystemCache = new Map()
  const copyBudget = createWorktreeCopyBudgetTracker(options.copyBudget)
  const skipped: SkippedWorktreeCopyPath[] = []

  for (const rawPath of paths) {
    const safePath = getSafeRelativePath(rawPath)
    if (!safePath.safe) {
      console.warn(`[worktree-symlinks] Skipping unsafe path "${rawPath}"`)
      continue
    }

    const source = resolve(primaryPath, safePath.rel)
    const target = resolve(worktreePath, safePath.rel)
    let sourceIsDirectory = false
    let sourceIsSymbolicLink = false
    try {
      sourceIsSymbolicLink = (await lstat(source)).isSymbolicLink()
      sourceIsDirectory = (await stat(source)).isDirectory()
    } catch {
      continue
    }
    if (await targetExists(target)) {
      continue
    }

    let copySource = source
    let bytesAreCopied = true
    let measuredBytes = 0
    if (mode === 'copy' || mode === 'apfs-only') {
      try {
        if (sourceIsSymbolicLink) {
          copySource = await realpath(source)
        }
        if (mode === 'copy' && !allowUnboundedCopyFallback) {
          bytesAreCopied = !(await copyIsCopyOnWrite(
            copySource,
            worktreePath,
            effectiveOptions,
            apfsFilesystemCache
          ))
          const verdict = await copyBudget.admit(copySource, { bytesAreCopied })
          if (!verdict.withinBudget) {
            skipped.push({ path: safePath.rel, reason: verdict.reason })
            console.warn(
              `[worktree-symlinks] Skipping "${safePath.rel}": copy exceeds the worktree copy budget (${verdict.reason})`
            )
            continue
          }
          measuredBytes = verdict.bytes
        }
      } catch (error) {
        console.error(`[worktree-symlinks] Failed to prepare "${safePath.rel}" (${source}):`, error)
        materializationFailures?.push(safePath.rel)
        continue
      }
    }

    try {
      const result = await createWorktreeLinkedPath(
        source,
        copySource,
        target,
        sourceIsDirectory,
        sourceIsSymbolicLink,
        mode,
        effectiveOptions,
        apfsFilesystemCache,
        () => allowUnboundedCopyFallback || bytesAreCopied || copyBudget.chargeBytes(measuredBytes)
      )
      if (result === 'skipped') {
        materializationFailures?.push(safePath.rel)
      }
    } catch (error) {
      if (error instanceof WorktreeCopyBudgetFallbackError) {
        skipped.push({ path: safePath.rel, reason: 'bytes' })
        console.warn(`[worktree-symlinks] Skipping "${safePath.rel}": ${error.message}`)
        continue
      }
      if (
        error instanceof WorktreeLinkedPathTargetExistsError ||
        ((hasErrorCode(error, 'EEXIST') || hasErrorCode(error, 'ERR_FS_CP_EEXIST')) &&
          (await targetExists(target)))
      ) {
        console.warn(
          `[worktree-symlinks] Materialization target appeared before publish for "${target}"; preserving it`
        )
        continue
      }
      materializationFailures?.push(safePath.rel)
      console.error(
        `[worktree-symlinks] Failed to materialize "${safePath.rel}" (${source} -> ${target}):`,
        error
      )
    }
  }
  return skipped
}
