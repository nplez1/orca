/**
 * Moving a primary checkout into its project folder.
 *
 * Only ever runs as an explicit, host-scoped action: the move breaks every linked worktree until
 * `git worktree repair` re-establishes them, so nothing here is triggered by a scan or a load.
 * The planner is pure so `--dry-run` can report the same decision the action would make.
 */
import type { GlobalSettings } from '../shared/global-settings-types'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../shared/execution-host'
import { isProjectFolderLayout, resolveWorktreeLayoutMode } from '../shared/orca-workspace-layout'
import { isFolderRepo } from '../shared/repo-kind'
import type { Repo } from '../shared/repo-types'
import { getRepoMainWorktreeId } from '../shared/worktree/id'
import { getRuntimePathOps, sanitizeWorktreeName } from './ipc/project-folder-placement'
import { areWorktreePathsEqual } from './ipc/worktree-path-comparison'
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

export type RelocationDependencies = {
  pathExists: (path: string) => Promise<boolean>
  /** False when a `rename` would cross volumes, where it fails outright. */
  isSameVolume: (from: string, to: string) => Promise<boolean>
  /** True when this repo has a live agent session on any of its worktrees. */
  hasLiveSessions: (repo: Pick<Repo, 'id' | 'path'>) => Promise<boolean>
  makeDirectory: (path: string) => Promise<void>
  moveDirectory: (from: string, to: string) => Promise<void>
  /** `git worktree repair` in the relocated checkout. */
  repairWorktrees: (movedRepoPath: string) => Promise<void>
  /** The new `Repo.path`. Deliberately narrow: relocation is the only caller. */
  setRepoPath: (repoId: string, newPath: string) => void
  migrateWorktreeIdentity: (oldWorktreeId: string, newWorktreeId: string) => void
  notifyRepoRelocated: (repoId: string, oldWorktreeId: string, newWorktreeId: string) => void
}

export type RelocationOutcome =
  | { kind: 'relocated'; from: string; to: string }
  | { kind: 'skipped'; reason: 'live-sessions' | 'target-exists' | 'cross-volume' }

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
  if (!(await deps.isSameVolume(from, to))) {
    // Why refuse instead of copy-and-delete: a copy that fails halfway leaves two checkouts and
    // no way to know which one the records should point at.
    return { kind: 'skipped', reason: 'cross-volume' }
  }

  await deps.makeDirectory(plan.containerPath)
  await deps.moveDirectory(from, to)
  try {
    await deps.repairWorktrees(to)
    deps.setRepoPath(repo.id, to)
  } catch (error) {
    await deps.moveDirectory(to, from).catch(() => {})
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
