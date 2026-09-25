import { symlink, mkdir, cp } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  ApfsCloneUnavailableError,
  canCloneWithApfs,
  cloneWorktreePathWithApfs,
  defaultApfsCloneDeps,
  WorktreeLinkedPathTargetExistsError,
  type ApfsCloneDeps,
  type DarwinFilesystemCache
} from './worktree-apfs-clone'
import { materializeWorktreePathThroughStaging } from './worktree-materialization-staging'
import type { WorktreeCopyBudget } from './worktree-include-copy-budget'
import type { WorktreeSharedDirectoriesMode } from '../../shared/repo-types'

export type WorktreeLinkedPathOptions = {
  platform?: NodeJS.Platform
  cloneWorktreePath?: (source: string, target: string, sourceIsDirectory: boolean) => Promise<void>
  apfsCloneDeps?: ApfsCloneDeps
  /** Copy-mode only. Overridable so tests can trip the bound without writing
   *  gigabytes to disk. */
  copyBudget?: WorktreeCopyBudget
  /** Overridable so tests cover staging filesystems without hard-link support. */
  linkStagedFile?: (source: string, target: string) => Promise<void>
  sharedDirectoriesMode?: WorktreeSharedDirectoriesMode
}

export type WorktreeMaterializeMode = 'link' | 'copy' | 'share' | 'apfs-only'
export type WorktreeLinkedPathResult = 'materialized' | 'preserved-target' | 'skipped'

/** The `fs.symlink` types to attempt, in order, for one materialized path. */
/** The `fs.symlink` types to try in order for one materialized path.
 *  Windows directory junctions need no privilege, but cannot target a UNC path,
 *  so retain the plain symlink fallback for WSL-hosted workspaces. */
export function worktreeSymlinkTypeCandidates(
  platform: NodeJS.Platform,
  sourceIsDirectory: boolean
): ('junction' | 'dir' | 'file')[] {
  if (!sourceIsDirectory) {
    return ['file']
  }
  return platform === 'win32' ? ['junction', 'dir'] : ['dir']
}

async function symlinkWorktreePath(
  source: string,
  target: string,
  sourceIsDirectory: boolean,
  platform: NodeJS.Platform
): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  const candidates = worktreeSymlinkTypeCandidates(platform, sourceIsDirectory)
  for (let index = 0; index < candidates.length; index++) {
    try {
      await symlink(source, target, candidates[index])
      return
    } catch (error) {
      if (index === candidates.length - 1) {
        throw error
      }
    }
  }
}

export async function copyWorktreePath(source: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  // Why: a staging-path collision must fail rather than merge into existing data.
  await cp(source, target, { recursive: true, force: false, errorOnExist: true })
}

export class WorktreeCopyBudgetFallbackError extends Error {
  constructor(target: string) {
    super(`APFS clone failed and a real copy of "${target}" would exceed the copy budget`)
    this.name = 'WorktreeCopyBudgetFallbackError'
  }
}

export async function createWorktreeLinkedPath(
  source: string,
  copySource: string,
  target: string,
  sourceIsDirectory: boolean,
  sourceIsSymbolicLink: boolean,
  mode: WorktreeMaterializeMode,
  options: WorktreeLinkedPathOptions,
  apfsFilesystemCache: DarwinFilesystemCache,
  realCopyFallbackAllowed: () => boolean
): Promise<WorktreeLinkedPathResult> {
  // Why: legacy share mode preserves live sharing; APFS modes are explicit
  // because a clone is an independent copy, not a shared-write directory.
  if (
    mode !== 'share' &&
    options.platform === 'darwin' &&
    (!sourceIsSymbolicLink || mode === 'copy' || mode === 'apfs-only')
  ) {
    try {
      const cloneWorktreePath =
        options.cloneWorktreePath ??
        ((cloneSource: string, cloneTarget: string, cloneSourceIsDirectory: boolean) =>
          cloneWorktreePathWithApfs(
            cloneSource,
            cloneTarget,
            cloneSourceIsDirectory,
            options.apfsCloneDeps ?? defaultApfsCloneDeps,
            apfsFilesystemCache
          ))
      await materializeWorktreePathThroughStaging(
        (stagedTarget) => cloneWorktreePath(copySource, stagedTarget, sourceIsDirectory),
        target,
        sourceIsDirectory,
        options.linkStagedFile
      )
      return 'materialized'
    } catch (error) {
      if (error instanceof WorktreeLinkedPathTargetExistsError) {
        console.warn(
          `[worktree-symlinks] Materialization target appeared before publish for "${target}"; preserving it`
        )
        return 'preserved-target'
      }
      // Why: APFS clone-copy can fail across volumes or on non-APFS disks.
      if (!(error instanceof ApfsCloneUnavailableError)) {
        console.warn(`[worktree-symlinks] APFS clone-copy unavailable for "${target}":`, error)
      }
      if (mode === 'copy' && !realCopyFallbackAllowed()) {
        throw new WorktreeCopyBudgetFallbackError(target)
      }
    }
  }
  if (mode === 'copy') {
    await materializeWorktreePathThroughStaging(
      (stagedTarget) => copyWorktreePath(copySource, stagedTarget),
      target,
      sourceIsDirectory,
      options.linkStagedFile
    )
    return 'materialized'
  }
  if (mode === 'apfs-only') {
    console.warn(
      `[worktree-shared-directories] Skipping "${target}": APFS-only materialization did not complete`
    )
    return 'skipped'
  }
  await symlinkWorktreePath(source, target, sourceIsDirectory, options.platform ?? process.platform)
  return 'materialized'
}

export async function copyIsCopyOnWrite(
  source: string,
  worktreePath: string,
  options: WorktreeLinkedPathOptions,
  apfsFilesystemCache: DarwinFilesystemCache
): Promise<boolean> {
  if (options.platform !== 'darwin') {
    return false
  }
  // An injected clone stands in for the real one, so tests remain host-independent.
  if (options.cloneWorktreePath) {
    return true
  }
  return await canCloneWithApfs(
    source,
    worktreePath,
    options.apfsCloneDeps ?? defaultApfsCloneDeps,
    apfsFilesystemCache
  )
}
