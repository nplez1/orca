// Whether a pull request is a bot's own work, by its head branch: a from=me rule starts on a pull
// request its owner opened, never on one a bot's worker opened as them (own-pr-trigger-guard.ts).
import { normalizeLocalBranchName } from '../runtime/workspaces/catalog/runtime-worktree-selection'
import { splitWorktreeId } from '../../shared/worktree/id'
import { getRepoRoutingConnectionId } from '../../shared/execution-host/execution-host'
import {
  folderWorkspaceKey,
  type WorkspaceKey
} from '../../shared/workspace/identity/workspace-scope'
import type { WorkspaceLineage } from '../../shared/worktree/lineage-types'
import type { Bot } from '../../shared/bot-types'
import type { BotWorkRow } from './bot-work-store'
import type { BotWorkRuntime } from './bot-work-runtime'
import type { BotWorkWorker } from './bot-work-types'
import { worktreesUnderHomes } from './bot-handed-workspaces'

/** A GitHub pull request's repository, as its webhook names it. */
export type BotPrRepo = {
  repoId: number
  /** owner/name, matched only when the workspace's repository id can't be read. */
  repoFullName: string
}

/** A repository by its id, which survives a rename or transfer, and its name, for when the id
 *  can't be read. */
export type BotGitHubRepo = { id: number | null; fullName: string }

/** A workspace's checked-out branch, and the GitHub repository it tracks, read only when asked. */
export type BotBranchWorkspace = {
  /** Null on a detached HEAD. */
  branch: string | null
  /** Null when it can't be told. */
  githubRepo: () => Promise<BotGitHubRepo | null>
}

/** A pull request by its base repository and number, and its head branch and repository. */
export type BotWorkPrHead = BotPrRepo & { number: number; head: BotPrRepo; headRef: string }

export type BotWorkRows = {
  /** Live rows of this profile's bots, as the bots DB worker reads them. */
  rows: () => Promise<readonly BotWorkRow[]>
  /** A row's worker's workspace now; null once it is closed or when it can't be read. */
  workspace: (row: BotWorkRow) => Promise<BotBranchWorkspace | null>
}

/** By id; by name when the id can't be read and the pull request names the repository (a fork's
 *  isn't sent). 'unknown' when neither can be told. */
async function repoMatches(
  workspace: BotBranchWorkspace,
  repo: BotPrRepo
): Promise<boolean | 'unknown'> {
  const own = await workspace.githubRepo().catch(() => null)
  if (!own) {
    return 'unknown'
  }
  if (own.id !== null) {
    return own.id === repo.repoId
  }
  return repo.repoFullName
    ? own.fullName.toLowerCase() === repo.repoFullName.toLowerCase()
    : 'unknown'
}

/**
 * The workspace has this branch checked out in this repository, at any commit. On that branch in a
 * repository that can't be told, it counts as on it: unknown never lets the bot's own pull request
 * start a run.
 */
export async function workspaceOnBranch(
  workspace: BotBranchWorkspace,
  repo: BotPrRepo,
  headRef: string
): Promise<boolean> {
  if (
    !workspace.branch ||
    normalizeLocalBranchName(workspace.branch) !== normalizeLocalBranchName(headRef)
  ) {
    return false
  }
  return (await repoMatches(workspace, repo)) !== false
}

/**
 * A live worker whose workspace has its head branch in the head's repository, at any commit. Binds
 * nothing. A workspace that can't be read now (an offline host) counts as not on it; one on the
 * branch whose repository can't be told counts as on it.
 */
export async function botWorkHasPrBranch(work: BotWorkRows, pr: BotWorkPrHead): Promise<boolean> {
  for (const row of await work.rows()) {
    const workspace = await work.workspace(row).catch(() => null)
    if (workspace && (await workspaceOnBranch(workspace, pr.head, pr.headRef))) {
      return true
    }
  }
  return false
}

/** What a bot's home lineage is read from: the work record's runtime, this host's bots, and the
 *  workspace tree. */
export type BotHomeLineage = {
  listWorkspaceLineage: () => Promise<Readonly<Record<WorkspaceKey, WorkspaceLineage>>>
  /** This host's bots, read per call. */
  bots: { list: () => readonly Bot[] }
}

/** A worktree of this host's checked-out branch, as its row shows it; null when it can't be read,
 *  and a 'gone' worktree is on no branch either. */
async function worktreeBranchOf(
  runtime: BotWorkRuntime,
  worktreeId: string
): Promise<string | null> {
  const worktree = await runtime.showManagedTerminalWorkspace(`id:${worktreeId}`).catch(() => null)
  return worktree?.branch || null
}

/** The GitHub repository a worktree of this host tracks on this branch, else its origin. */
async function localGitHubRepo(
  runtime: BotWorkRuntime,
  worktreeId: string,
  branch: string
): Promise<BotGitHubRepo | null> {
  const parsed = splitWorktreeId(worktreeId)
  const repo =
    parsed &&
    runtime
      .linkStore()
      ?.getRepos()
      .find((entry) => entry.id === parsed.repoId)
  if (!repo) {
    return null
  }
  // Loaded on first use: GitHub lookups pull the git stack into whatever imports bots.
  const { getGitHubTrackedRepository } = await import('./bot-work-pr-github-repo')
  return getGitHubTrackedRepository(
    repo.path,
    normalizeLocalBranchName(branch),
    getRepoRoutingConnectionId(repo)
  )
}

/** The GitHub repository a worker's workspace tracks on its branch: here, or on its paired server
 *  by name. Null when it can't be told. */
export async function workerGitHubRepo(
  runtime: BotWorkRuntime,
  worker: BotWorkWorker,
  branch: string
): Promise<BotGitHubRepo | null> {
  if (worker.host !== 'local') {
    // Loaded on first use: GitHub lookups pull the git stack into whatever imports bots.
    const { readRemoteGitHubRepo } = await import('./bot-work-pr-github-repo')
    return readRemoteGitHubRepo(runtime, worker)
  }
  return worker.worktreeId ? localGitHubRepo(runtime, worker.worktreeId, branch) : null
}

/**
 * Whether a worktree under a bot's home (made there by its workers, or handed to it) has this branch
 * checked out in this repository: a pull request from it is the bot's work, even after its work row
 * closed. One that can't be read counts as not on it.
 */
export async function botHomeWorktreeOnBranch(
  runtime: BotWorkRuntime & BotHomeLineage,
  repo: BotPrRepo,
  headRef: string
): Promise<boolean> {
  const homes = runtime.bots.list().map((bot) => folderWorkspaceKey(bot.folderWorkspaceId))
  const under = worktreesUnderHomes(await runtime.listWorkspaceLineage(), homes)
  for (const worktreeId of new Set([...under.values()].flatMap((ids) => [...ids]))) {
    const branch = await worktreeBranchOf(runtime, worktreeId)
    if (
      branch &&
      (await workspaceOnBranch(
        { branch, githubRepo: () => localGitHubRepo(runtime, worktreeId, branch) },
        repo,
        headRef
      ))
    ) {
      return true
    }
  }
  return false
}
