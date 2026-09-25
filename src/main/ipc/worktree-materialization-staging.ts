import { constants as fsConstants } from 'node:fs'
import {
  copyFile,
  link,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { isPathInsideOrEqual } from '../../shared/cross-platform-path'
import { getSafeRelativePath } from '../git/worktree-symlink-detection'
import { WorktreeLinkedPathTargetExistsError } from './worktree-apfs-clone'

const WORKTREE_STAGING_DIRECTORY_PREFIX = '.orca-worktree-stage-'
const WORKTREE_STAGING_DIRECTORY_PATTERN = /^\.orca-worktree-stage-(\d+)-[A-Za-z0-9]{6}$/u
const WORKTREE_STAGING_OWNER_FILE = '.orca-worktree-stage-owner'
const ACTIVE_WORKTREE_STAGING_DIRECTORIES = new Set<string>()

export async function targetExists(target: string): Promise<boolean> {
  try {
    await lstat(target)
    return true
  } catch {
    return false
  }
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errorCode(error) !== 'ESRCH'
  }
}

export async function createWorktreeMaterializationStagingDirectory(
  targetPath: string
): Promise<string> {
  await mkdir(dirname(targetPath), { recursive: true })
  const stagingDirectory = await mkdtemp(
    join(dirname(targetPath), `${WORKTREE_STAGING_DIRECTORY_PREFIX}${process.pid}-`)
  )
  const lexicalStagingDirectory = resolve(stagingDirectory)
  const absoluteStagingDirectory = await realpath(stagingDirectory).catch(
    () => lexicalStagingDirectory
  )
  ACTIVE_WORKTREE_STAGING_DIRECTORIES.add(lexicalStagingDirectory)
  ACTIVE_WORKTREE_STAGING_DIRECTORIES.add(absoluteStagingDirectory)
  try {
    await writeFile(join(stagingDirectory, WORKTREE_STAGING_OWNER_FILE), `${process.pid}\n`, {
      flag: 'wx',
      mode: 0o600
    })
  } catch (error) {
    await removeWorktreeMaterializationStagingDirectory(stagingDirectory).catch(() => {})
    throw error
  }
  return stagingDirectory
}

export async function removeWorktreeMaterializationStagingDirectory(
  stagingDirectory: string
): Promise<void> {
  const lexicalStagingDirectory = resolve(stagingDirectory)
  const absoluteStagingDirectory = await realpath(stagingDirectory).catch(
    () => lexicalStagingDirectory
  )
  try {
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await rm(stagingDirectory, { recursive: true, force: true })
        return
      } catch (error) {
        lastError = error
        if (attempt < 2) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 25))
        }
      }
    }
    throw lastError
  } finally {
    ACTIVE_WORKTREE_STAGING_DIRECTORIES.delete(lexicalStagingDirectory)
    ACTIVE_WORKTREE_STAGING_DIRECTORIES.delete(absoluteStagingDirectory)
  }
}

export async function publishStagedFile(
  source: string,
  target: string,
  linkStagedFile: (source: string, target: string) => Promise<void> = link
): Promise<void> {
  try {
    await linkStagedFile(source, target)
    return
  } catch {
    if (await targetExists(target)) {
      throw new WorktreeLinkedPathTargetExistsError(target)
    }
  }
  await copyFile(source, target, fsConstants.COPYFILE_EXCL | fsConstants.COPYFILE_FICLONE)
}

export async function materializeWorktreePathThroughStaging(
  materialize: (stagedTarget: string) => Promise<void>,
  target: string,
  sourceIsDirectory: boolean,
  linkStagedFile: (source: string, target: string) => Promise<void> = link
): Promise<void> {
  const stagingDirectory = await createWorktreeMaterializationStagingDirectory(target)
  const stagedTarget = join(stagingDirectory, 'materialized')
  let materializationFailed = false
  let materializationFailure: unknown
  let materialized = false
  try {
    await materialize(stagedTarget)
    if (sourceIsDirectory) {
      // Why: Node has no portable no-replace directory rename; POSIX can replace
      // an empty directory created after this check, detaching its open handles.
      if (await targetExists(target)) {
        throw new WorktreeLinkedPathTargetExistsError(target)
      }
      try {
        await rename(stagedTarget, target)
        materialized = true
      } catch (error) {
        if (await targetExists(target)) {
          throw new WorktreeLinkedPathTargetExistsError(target)
        }
        throw error
      }
    } else {
      await publishStagedFile(stagedTarget, target, linkStagedFile)
      materialized = true
    }
  } catch (error) {
    materializationFailed = true
    materializationFailure = error
  }
  await removeWorktreeMaterializationStagingDirectory(stagingDirectory).catch((error: unknown) => {
    console.error(
      `[worktree-symlinks] ${materialized ? 'Materialized' : 'Failed to materialize'} "${target}" but could not clean staging directory "${stagingDirectory}":`,
      error
    )
  })
  if (materializationFailed) {
    throw materializationFailure
  }
}

export async function removeStaleWorktreeMaterializationStagingDirectories(
  worktreePath: string,
  materializedPaths: readonly string[]
): Promise<void> {
  const canonicalWorktreePath = await realpath(worktreePath).catch(() => resolve(worktreePath))
  const parents = new Set([canonicalWorktreePath])
  for (const rawPath of materializedPaths) {
    const safePath = getSafeRelativePath(rawPath)
    if (!safePath.safe) {
      continue
    }
    const parent = await realpath(dirname(resolve(worktreePath, safePath.rel))).catch(
      () => undefined
    )
    if (parent && isPathInsideOrEqual(canonicalWorktreePath, parent)) {
      parents.add(parent)
    }
  }

  for (const parent of parents) {
    const entries = await readdir(parent, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const nameMatch = WORKTREE_STAGING_DIRECTORY_PATTERN.exec(entry.name)
      if (!entry.isDirectory() || !nameMatch) {
        continue
      }
      const stagingDirectory = resolve(parent, entry.name)
      if (ACTIVE_WORKTREE_STAGING_DIRECTORIES.has(stagingDirectory)) {
        continue
      }
      const ownerContents = await readFile(
        join(stagingDirectory, WORKTREE_STAGING_OWNER_FILE),
        'utf8'
      ).catch(() => '')
      const ownerPid = Number(ownerContents.trim())
      const nameOwnerPid = Number(nameMatch[1])
      if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0 || ownerPid !== nameOwnerPid) {
        console.warn(
          `[worktree-symlinks] Preserving unverified staging directory "${stagingDirectory}"`
        )
        continue
      }
      if (ownerPid !== process.pid && isProcessAlive(ownerPid)) {
        console.warn(
          `[worktree-symlinks] Preserving active staging directory "${stagingDirectory}"`
        )
        continue
      }
      try {
        await removeWorktreeMaterializationStagingDirectory(stagingDirectory)
      } catch (error) {
        console.error(
          `[worktree-symlinks] Failed to remove stale staging directory "${stagingDirectory}":`,
          error
        )
      }
    }
  }
}
