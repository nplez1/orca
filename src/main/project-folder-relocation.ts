/**
 * Moving a primary checkout into its project folder.
 *
 * Only ever runs as an explicit, host-scoped action: the move breaks every linked worktree until
 * `git worktree repair` re-establishes them, so nothing here is triggered by a scan or a load.
 * The planner is pure so `--dry-run` can report the same decision the action would make.
 */
import type { GlobalSettings } from '../shared/global-settings-types'
import { stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../shared/execution-host'
import { isProjectFolderLayout, resolveWorktreeLayoutMode } from '../shared/orca-workspace-layout'
import { isFolderRepo } from '../shared/repo-kind'
import type { Repo } from '../shared/repo-types'
import { areWorktreePathsEqual } from '../shared/worktree-path-comparison'
import { getRepoMainWorktreeId } from '../shared/worktree/id'
import { getRuntimePathOps, sanitizeWorktreeName } from './ipc/project-folder-placement'
import { computeWorkspaceRoot, getWorktreePathSettings } from './ipc/worktree-logic'

export type RelocationSkipReason =
  | 'not-project-folder-layout'
  | 'already-in-container'
  | 'remote-host'
  | 'windows'
  | 'not-a-git-repo'
  | 'unknown-default-branch'

export type RelocationPlan = {
  /** The project folder the checkout belongs in. */
  containerPath: string
  /** Where the checkout goes: `<container>/<defaultBranch>`. */
  targetPath: string
  defaultBranchName: string
}

export type RelocationDecision =
  | { kind: 'ready'; plan: RelocationPlan }
  | { kind: 'skipped'; reason: RelocationSkipReason }

/** Everything the eligibility rule reads; a full `Repo` and the store's settings satisfy it. */
export type RelocationCandidateArgs = {
  repo: Pick<Repo, 'path' | 'displayName' | 'worktreeBasePath' | 'kind' | 'connectionId'>
  /** Effective execution host, already resolved by the caller that owns the store. */
  executionHostId?: string | null
  settings: RelocationSettings
  platform: NodeJS.Platform
}

/**
 * Whether this checkout sits outside its project folder, and where the folder is.
 *
 * Deliberately free of git: the default branch is only needed to *name* the folder, so a listing
 * can ask this without paying for a branch resolution per repo. Returns null when the repo is not
 * eligible at all, which is what keeps detection and the move from disagreeing.
 */
export function resolveRelocationTarget(args: RelocationCandidateArgs): {
  containerPath: string
  alreadyInContainer: boolean
} | null {
  const { repo, settings } = args
  if (!isProjectFolderLayout(resolveWorktreeLayoutMode(settings))) {
    return null
  }
  if (isFolderRepo(repo) || repo.kind === 'folder') {
    return null
  }
  if ((args.executionHostId ?? getRepoExecutionHostId(repo)) !== LOCAL_EXECUTION_HOST_ID) {
    return null
  }
  // Why Windows is not a candidate: the OS locks a directory that is any process's cwd, so the
  // move is not available there yet — and reporting it as needed would be unactionable.
  if (args.platform === 'win32') {
    return null
  }
  const pathOps = getRuntimePathOps(repo.path, settings.workspaceDir)
  const containerPath = computeWorkspaceRoot(
    repo.path,
    getWorktreePathSettings(repo, settings, settings.wslMirrorDistro)
  )
  return {
    containerPath,
    alreadyInContainer: areWorktreePathsEqual(pathOps.dirname(repo.path), containerPath)
  }
}

/** True when a relocation would have something to do here, before asking about the branch. */
export function isCheckoutOutsideProjectFolder(args: RelocationCandidateArgs): boolean {
  const target = resolveRelocationTarget(args)
  return target !== null && !target.alreadyInContainer
}

type RelocationSettings = Pick<
  GlobalSettings,
  'workspaceDir' | 'nestWorkspaces' | 'worktreeLayoutMode'
> & { wslMirrorDistro?: string }

/**
 * Decide whether this repo's primary checkout belongs somewhere else.
 *
 * `skipped` is not an error: most repos are already where they belong, and every refusal here is
 * something the caller reports rather than works around. Windows is a refusal because the OS
 * locks a directory that is any process's cwd, and a remote checkout is a refusal because moving
 * it is a decision about the host that owns it.
 */
export function planPrimaryCheckoutRelocation(args: {
  repo: Pick<Repo, 'path' | 'displayName' | 'worktreeBasePath' | 'kind' | 'connectionId'>
  /** Effective execution host, already resolved by the caller that owns the store. */
  executionHostId?: string | null
  settings: RelocationSettings
  defaultBranchName: string | null
  platform: NodeJS.Platform
}): RelocationDecision {
  const { repo, settings } = args
  const target = resolveRelocationTarget(args)
  if (!target) {
    // The four ways a repo is not a candidate, reported individually so a caller can say which.
    if (!isProjectFolderLayout(resolveWorktreeLayoutMode(settings))) {
      return { kind: 'skipped', reason: 'not-project-folder-layout' }
    }
    if (isFolderRepo(repo) || repo.kind === 'folder') {
      return { kind: 'skipped', reason: 'not-a-git-repo' }
    }
    if ((args.executionHostId ?? getRepoExecutionHostId(repo)) !== LOCAL_EXECUTION_HOST_ID) {
      return { kind: 'skipped', reason: 'remote-host' }
    }
    return { kind: 'skipped', reason: 'windows' }
  }
  if (target.alreadyInContainer) {
    return { kind: 'skipped', reason: 'already-in-container' }
  }
  const defaultBranchName = args.defaultBranchName?.trim()
  if (!defaultBranchName) {
    // Why refuse rather than fall back to `main`: the folder is named once, and naming it after a
    // guess would leave the checkout in a folder that does not match its branch.
    return { kind: 'skipped', reason: 'unknown-default-branch' }
  }
  const pathOps = getRuntimePathOps(repo.path, settings.workspaceDir)
  return {
    kind: 'ready',
    plan: {
      containerPath: target.containerPath,
      targetPath: pathOps.join(target.containerPath, sanitizeWorktreeName(defaultBranchName)),
      defaultBranchName
    }
  }
}

/**
 * Whether `rename` can move between these two paths at all, or why that cannot be answered.
 *
 * Exported because the executor takes it as a dependency: a caller wiring the real move has to use
 * this rather than its own comparison, or the two drift and a refusal looks real when it is not.
 *
 * Why the nearest existing ancestor rather than `dirname(to)`: the container is created by this
 * move, so it usually does not exist yet, and stat'ing a missing path is not a volume answer. The
 * ancestor that does exist is on the volume the container will be created on.
 *
 * Why three answers rather than a boolean: a `stat` failure is not a volume answer, and reporting it
 * as `cross-volume` tells the user their disks are arranged differently when the truth is that this
 * host cannot read the path at all.
 */
export type VolumeRelation = 'same' | 'cross-volume' | 'unreadable'

export async function volumeRelationBetween(from: string, to: string): Promise<VolumeRelation> {
  try {
    const [fromStats, targetParentStats] = await Promise.all([
      stat(from),
      stat(await nearestExistingAncestor(dirname(to)))
    ])
    return fromStats.dev === targetParentStats.dev ? 'same' : 'cross-volume'
  } catch {
    return 'unreadable'
  }
}

async function nearestExistingAncestor(path: string): Promise<string> {
  let candidate = path
  for (;;) {
    try {
      await stat(candidate)
      return candidate
    } catch {
      const parent = dirname(candidate)
      if (parent === candidate) {
        return candidate
      }
      candidate = parent
    }
  }
}

export type RelocationDependencies = {
  pathExists: (path: string) => Promise<boolean>
  /** How a `rename` would treat these paths; `unreadable` means the question cannot be answered. */
  volumeRelation: (from: string, to: string) => Promise<VolumeRelation>
  /** True when this repo has a live agent session on any of its worktrees. */
  hasLiveSessions: (repo: Pick<Repo, 'id' | 'path'>) => Promise<boolean>
  makeDirectory: (path: string) => Promise<void>
  moveDirectory: (from: string, to: string) => Promise<void>
  /** `git worktree repair` in the relocated checkout. */
  repairWorktrees: (movedRepoPath: string) => Promise<void>
  /** The new `Repo.path`. Deliberately narrow: relocation is the only caller, and the row it moves
   *  is the one the plan was built from. */
  setRepoPath: (newPath: string) => void
  migrateWorktreeIdentity: (oldWorktreeId: string, newWorktreeId: string) => void
  notifyRepoRelocated: (repoId: string, oldWorktreeId: string, newWorktreeId: string) => void
}

export type RelocationOutcome =
  | { kind: 'relocated'; from: string; to: string }
  | { kind: 'skipped'; reason: 'live-sessions' | 'target-exists' | 'cross-volume' }

/**
 * A rollback that failed: the checkout is at `currentPath` while the saved repo path still names
 * `originalPath`.
 *
 * Why its own error: the caller's message said the move was undone, so the repo then read as missing
 * at a path it had left — the one fact the user needs is where the folder actually is.
 */
export class RelocationRollbackFailedError extends Error {
  constructor(
    readonly currentPath: string,
    readonly originalPath: string,
    /** The failure that started the rollback, and the rollback's own — both are the user's problem. */
    cause: unknown,
    rollbackCause: unknown
  ) {
    super(
      `Moving the checkout into its project folder failed and moving it back to ${originalPath} failed too, so the folder is still at ${currentPath}`,
      { cause: { move: cause, rollback: rollbackCause } }
    )
    this.name = 'RelocationRollbackFailedError'
  }
}

/** The volume question could not be answered, so no move was attempted. */
export class RelocationVolumeUnreadableError extends Error {
  constructor(
    readonly from: string,
    readonly to: string
  ) {
    super(`Could not read ${from} or the destination for ${to}, so the checkout was not moved`)
    this.name = 'RelocationVolumeUnreadableError'
  }
}

/**
 * Perform the move: directory, then `git worktree repair`, then the records that point at the old
 * path.
 *
 * Order is deliberate. The move is the point of no return; everything after it either repairs or
 * records, and any failure there moves the directory back so the repo is never left with a
 * checkout at a path its records disagree with.
 */
export async function relocatePrimaryCheckout(args: {
  repo: Pick<Repo, 'id' | 'path'>
  plan: RelocationPlan
  deps: RelocationDependencies
}): Promise<RelocationOutcome> {
  const { repo, plan, deps } = args
  const from = repo.path
  const to = plan.targetPath
  if (from === to) {
    return { kind: 'skipped', reason: 'target-exists' }
  }
  // Why before anything moves: a live agent's process sits on a cwd inside the checkout, and
  // moving it out from under the session burns the session's tree.
  if (await deps.hasLiveSessions(repo)) {
    return { kind: 'skipped', reason: 'live-sessions' }
  }
  if (await deps.pathExists(to)) {
    return { kind: 'skipped', reason: 'target-exists' }
  }
  const relation = await deps.volumeRelation(from, to)
  if (relation === 'unreadable') {
    // Why throw rather than skip: `cross-volume` was a claim about the user's disks, and this is a
    // failure to read a path. Only one of the two is something the user can act on.
    throw new RelocationVolumeUnreadableError(from, to)
  }
  if (relation === 'cross-volume') {
    // Why refuse instead of copy-and-delete: a copy that fails halfway leaves two checkouts and
    // no way to know which one the records should point at.
    return { kind: 'skipped', reason: 'cross-volume' }
  }

  await deps.makeDirectory(plan.containerPath)
  await deps.moveDirectory(from, to)
  try {
    await deps.repairWorktrees(to)
    deps.setRepoPath(to)
  } catch (error) {
    try {
      await deps.moveDirectory(to, from)
    } catch (rollbackError) {
      // Why a distinct error naming `to`: the caller otherwise reports the original failure as if the
      // move had been undone, and the checkout is somewhere its records do not name.
      throw new RelocationRollbackFailedError(to, from, error, rollbackError)
    }
    // Why repair again: the repair above may already have pointed every linked worktree's gitdir at
    // the new path, so moving the directory back without this leaves them all broken — the failure
    // would then be worse than not having moved at all. A failure here does not hide the original.
    await deps.repairWorktrees(from).catch(() => {})
    throw error
  }
  // Order after the records: the worktree id is derived from the path, so re-keying before the
  // path is written would momentarily re-key to an id nothing else agrees with.
  const oldWorktreeId = getRepoMainWorktreeId(repo)
  const newWorktreeId = getRepoMainWorktreeId({ id: repo.id, path: to })
  deps.migrateWorktreeIdentity(oldWorktreeId, newWorktreeId)
  deps.notifyRepoRelocated(repo.id, oldWorktreeId, newWorktreeId)
  return { kind: 'relocated', from, to }
}
