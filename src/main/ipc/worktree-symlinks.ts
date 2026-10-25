import { lstat, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { SkippedWorktreeCopyPath } from './worktree-include-copy-budget'
import { materializeWorktreePaths } from './worktree-path-materializer'
import {
  worktreeSymlinkTypeCandidates,
  type WorktreeLinkedPathOptions
} from './worktree-path-publisher'
import {
  findExistingWorktreeSymlinkPaths,
  getSafeRelativePath
} from '../git/worktree-symlink-detection'

export type { WorktreeLinkedPathOptions } from './worktree-path-publisher'
export { findExistingWorktreeSymlinkPaths, worktreeSymlinkTypeCandidates }

export async function createWorktreeLinkedPaths(
  primaryPath: string,
  worktreePath: string,
  paths: readonly string[],
  options: WorktreeLinkedPathOptions = {}
): Promise<void> {
  await materializeWorktreePaths(primaryPath, worktreePath, paths, 'link', options)
}

/** Copy includes independently, isolate per-path failures, and report budget refusals to the creator. */
export async function createWorktreeCopiedPaths(
  primaryPath: string,
  worktreePath: string,
  paths: readonly string[],
  options: WorktreeLinkedPathOptions = {}
): Promise<SkippedWorktreeCopyPath[]> {
  return await materializeWorktreePaths(primaryPath, worktreePath, paths, 'copy', options)
}

/** Shared directories always link; cloning would defeat one-install-for-all dependency sharing. */
export async function createWorktreeSharedPaths(
  primaryPath: string,
  worktreePath: string,
  paths: readonly string[],
  options: WorktreeLinkedPathOptions = {}
): Promise<string[]> {
  const mode =
    options.sharedDirectoriesMode === 'apfs-symlink'
      ? 'link'
      : options.sharedDirectoriesMode === 'apfs-copy'
        ? 'copy'
        : options.sharedDirectoriesMode === 'apfs-only'
          ? 'apfs-only'
          : 'share'
  const failedPaths: string[] = []
  await materializeWorktreePaths(
    primaryPath,
    worktreePath,
    paths,
    mode,
    options,
    options.sharedDirectoriesMode === 'apfs-copy',
    failedPaths
  )
  return failedPaths
}

/** Link configured relative paths, creating nested parents and isolating per-path failures. */
export async function createWorktreeSymlinks(
  primaryPath: string,
  worktreePath: string,
  paths: readonly string[]
): Promise<void> {
  await createWorktreeLinkedPaths(primaryPath, worktreePath, paths, { platform: 'linux' })
}

export async function removeWorktreeLinkedPaths(
  worktreePath: string,
  paths: readonly string[]
): Promise<void> {
  for (const rawPath of paths) {
    const safePath = getSafeRelativePath(rawPath)
    if (!safePath.safe) {
      continue
    }
    const target = resolve(worktreePath, safePath.rel)
    try {
      if ((await lstat(target)).isSymbolicLink()) {
        await unlink(target)
      }
    } catch (error) {
      if ((error as { code?: unknown })?.code !== 'ENOENT') {
        console.error(`[worktree-symlinks] Failed to remove "${safePath.rel}" (${target}):`, error)
      }
    }
  }
}

/** Unlink only Orca-created symlinks before non-force worktree removal. */
export async function removeWorktreeSymlinks(
  worktreePath: string,
  paths: readonly string[]
): Promise<void> {
  await removeWorktreeLinkedPaths(worktreePath, paths)
}
