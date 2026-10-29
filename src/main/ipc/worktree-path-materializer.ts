import { lstat, realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { mapSettledWithConcurrency } from '../../shared/map-with-concurrency'
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
import { recordSwallowedFailure } from '../observability/swallowed-failure'
import { getSafeRelativePath } from '../git/worktree-symlink-detection'

const APFS_PATH_MATERIALIZATION_CONCURRENCY = 4

type PathMaterializationOutcome = {
  skipped?: SkippedWorktreeCopyPath
  failedPath?: string
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function materializationPathsAreIndependentTopLevelPaths(paths: readonly string[]): boolean {
  const pathsSeen = new Set<string>()
  for (const rawPath of paths) {
    const safePath = getSafeRelativePath(rawPath)
    if (!safePath.safe) {
      return false
    }
    const segments = safePath.rel
      .split(/[\\/]/u)
      .filter((segment) => segment.length > 0 && segment !== '.')
      .map((segment) => segment.normalize('NFD').toLowerCase())
    if (segments.length !== 1) {
      return false
    }
    // Why: root-level paths avoid parent/child targets and symlinked ancestors.
    // Case-folding conservatively serializes aliases on case-insensitive APFS.
    if (pathsSeen.has(segments[0])) {
      return false
    }
    pathsSeen.add(segments[0])
  }
  return true
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

  const materializePath = async (rawPath: string): Promise<PathMaterializationOutcome> => {
    const safePath = getSafeRelativePath(rawPath)
    if (!safePath.safe) {
      console.warn(`[worktree-symlinks] Skipping unsafe path "${rawPath}"`)
      return {}
    }

    const source = resolve(primaryPath, safePath.rel)
    const target = resolve(worktreePath, safePath.rel)
    let sourceIsDirectory = false
    let sourceIsSymbolicLink = false
    try {
      sourceIsSymbolicLink = (await lstat(source)).isSymbolicLink()
      sourceIsDirectory = (await stat(source)).isDirectory()
    } catch {
      return {}
    }
    if (await targetExists(target)) {
      return {}
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
            console.warn(
              `[worktree-symlinks] Skipping "${safePath.rel}": copy exceeds the worktree copy budget (${verdict.reason})`
            )
            return { skipped: { path: safePath.rel, reason: verdict.reason } }
          }
          measuredBytes = verdict.bytes
        }
      } catch (error) {
        recordSwallowedFailure(
          'worktree-symlinks',
          error,
          `failed to prepare "${safePath.rel}" (${source})`,
          'error'
        )
        return { failedPath: safePath.rel }
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
        return { failedPath: safePath.rel }
      }
    } catch (error) {
      if (error instanceof WorktreeCopyBudgetFallbackError) {
        recordSwallowedFailure('worktree-symlinks', error, `skipping "${safePath.rel}"`)
        return { skipped: { path: safePath.rel, reason: 'bytes' } }
      }
      if (
        error instanceof WorktreeLinkedPathTargetExistsError ||
        ((hasErrorCode(error, 'EEXIST') || hasErrorCode(error, 'ERR_FS_CP_EEXIST')) &&
          (await targetExists(target)))
      ) {
        console.warn(
          `[worktree-symlinks] Materialization target appeared before publish for "${target}"; preserving it`
        )
        return {}
      }
      recordSwallowedFailure(
        'worktree-symlinks',
        error,
        `failed to materialize "${safePath.rel}" (${source} -> ${target})`,
        'error'
      )
      return { failedPath: safePath.rel }
    }
    return {}
  }

  const recordOutcome = (outcome: PathMaterializationOutcome): void => {
    if (outcome.skipped) {
      skipped.push(outcome.skipped)
    }
    if (outcome.failedPath) {
      materializationFailures?.push(outcome.failedPath)
    }
  }

  const shouldParallelize =
    effectiveOptions.platform === 'darwin' &&
    (mode === 'link' || mode === 'apfs-only') &&
    paths.length > 1 &&
    materializationPathsAreIndependentTopLevelPaths(paths)
  if (shouldParallelize) {
    const outcomes = await mapSettledWithConcurrency(
      paths,
      APFS_PATH_MATERIALIZATION_CONCURRENCY,
      materializePath
    )
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        throw outcome.reason
      }
      recordOutcome(outcome.value)
    }
  } else {
    for (const rawPath of paths) {
      recordOutcome(await materializePath(rawPath))
    }
  }
  return skipped
}
