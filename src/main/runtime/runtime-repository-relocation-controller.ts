/**
 * Relocating a repo's primary checkout into its project folder, as an explicit host-side action.
 *
 * Everything that decides *whether* to move lives in `project-folder-relocation`; this wires that
 * decision to the real filesystem, git, and store, and owns the host-scoped refusals.
 */
import { mkdir, rename, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { Repo } from '../../shared/repo-types'
import type { RuntimeWorktreePsSummary } from '../../shared/runtime-worktree-contracts'
import type { RuntimeRepoRelocationResult } from '../../shared/repo-relocation-contracts'
import { gitExecFileAsync } from '../git/runner'
import { invalidateAuthorizedRootsCache } from '../ipc/filesystem-auth'
import {
  isCheckoutOutsideProjectFolder,
  planPrimaryCheckoutRelocation,
  relocatePrimaryCheckout,
  type RelocationDecision,
  type RelocationOutcome
} from '../project-folder-relocation'
import { getRepoDefaultBranchName } from '../source-control/repo-default-branch'
import { prepareLocalWorktreeRootForRepo } from '../worktree-root-preparation'
import type { RuntimeStore } from './runtime-store-contract'

/**
 * Only the store members this action needs, so a caller — and a test — need not own the whole
 * runtime store. `relocateRepoPath` stays optional so a host that cannot relocate records is a
 * refusal rather than a type error.
 */
export type RepoRelocationStore = {
  getRepo: RuntimeStore['getRepo']
  getRepos: RuntimeStore['getRepos']
  /** Declared structurally rather than as the whole settings object: this action reads three
   *  placement fields, and a caller should not have to own the rest to hand its store over. */
  getSettings: () => Pick<GlobalSettings, 'workspaceDir' | 'nestWorkspaces' | 'worktreeLayoutMode'>
  relocateRepoPath?: RuntimeStore['relocateRepoPath']
  migrateWorktreeIdentity?: RuntimeStore['migrateWorktreeIdentity']
}

export type RuntimeRepositoryRelocationDependencies = {
  getStore: () => RepoRelocationStore | null
  resolveRepo: (selector: string) => Promise<Repo>
  /** The host's workspace listing, which carries terminal liveness per workspace. */
  getWorktreePs: (limit: number) => Promise<WorktreePsSnapshot>
  notifyRepoRelocated: (repoId: string, oldWorktreeId: string, newWorktreeId: string) => void
  invalidateResolvedWorktrees: () => void
  notifyReposChanged: () => void
}

export type WorktreePsSnapshot = {
  truncated: boolean
  worktrees: readonly Pick<
    RuntimeWorktreePsSummary,
    'repoId' | 'hasAttachedPty' | 'liveTerminalCount' | 'unverifiableTerminalCount'
  >[]
}

/** Big enough that a real repo cannot truncate it; truncation is treated as "cannot verify". */
export const WORKTREE_LIVENESS_PROBE_LIMIT = 10_000

/**
 * Whether any workspace of this repo still has a terminal attached.
 *
 * Why unverifiable counts as live: a host that lost contact leaves a terminal that is neither
 * running nor exited, and loss of contact is never evidence a process died — so the move is
 * refused rather than pulling a directory out from under a session we cannot see.
 */
export function hasLiveWorktreeSessions(snapshot: WorktreePsSnapshot, repoId: string): boolean {
  if (snapshot.truncated) {
    // Why: a truncated page cannot prove the absence of a live session, so it is not an answer.
    return true
  }
  return snapshot.worktrees.some(
    (row) =>
      row.repoId === repoId &&
      (row.hasAttachedPty || row.liveTerminalCount > 0 || (row.unverifiableTerminalCount ?? 0) > 0)
  )
}

export class RuntimeRepositoryRelocationController {
  constructor(private readonly deps: RuntimeRepositoryRelocationDependencies) {}

  /**
   * Repos whose primary checkout sits outside its project folder.
   *
   * Detection is deliberately cheap and git-free, and shares its eligibility rule with the move
   * itself — so a repo listed here is one `relocate` would act on, not a near miss.
   */
  findReposRequiringRelocation(): string[] {
    const store = this.deps.getStore()
    if (!store) {
      return []
    }
    const settings = store.getSettings()
    return store
      .getRepos()
      .filter((repo) =>
        isCheckoutOutsideProjectFolder({
          repo,
          executionHostId: getRepoExecutionHostId(repo),
          settings,
          platform: process.platform
        })
      )
      .map((repo) => repo.id)
  }

  async relocate(
    repoSelector: string,
    options: { dryRun?: boolean } = {}
  ): Promise<RuntimeRepoRelocationResult> {
    const store = this.requireStore()
    const repo = await this.deps.resolveRepo(repoSelector)
    const decision = planPrimaryCheckoutRelocation({
      repo,
      executionHostId: getRepoExecutionHostId(repo),
      settings: store.getSettings(),
      // A checkout on a WSL filesystem resolves through the same repo path: when the distro cannot
      // answer, this reports no branch and the plan refuses rather than naming a folder by guess.
      defaultBranchName: await getRepoDefaultBranchName(repo.path, repo.connectionId),
      platform: process.platform
    })
    if (decision.kind !== 'ready' || options.dryRun) {
      return toWireResult(repo.id, decision)
    }

    const outcome = await relocatePrimaryCheckout({
      repo,
      plan: decision.plan,
      deps: {
        pathExists: (path) => pathExists(path),
        isSameVolume: (from, to) => isSameVolume(from, to),
        hasLiveSessions: async () =>
          hasLiveWorktreeSessions(
            await this.deps.getWorktreePs(WORKTREE_LIVENESS_PROBE_LIMIT),
            repo.id
          ),
        makeDirectory: async (path) => {
          await mkdir(path, { recursive: true })
        },
        moveDirectory: async (from, to) => {
          await rename(from, to)
        },
        repairWorktrees: async (movedRepoPath) => {
          await gitExecFileAsync(['worktree', 'repair'], { cwd: movedRepoPath })
        },
        setRepoPath: (repoId, newPath) => {
          const updated = store.relocateRepoPath?.(repoId, newPath)
          if (!updated) {
            throw new Error('repo_not_found')
          }
        },
        migrateWorktreeIdentity: (oldId, newId) => {
          if (!store.migrateWorktreeIdentity) {
            throw new Error('runtime_unavailable')
          }
          store.migrateWorktreeIdentity(oldId, newId)
        },
        notifyRepoRelocated: (repoId, oldId, newId) =>
          this.deps.notifyRepoRelocated(repoId, oldId, newId)
      }
    })

    if (outcome.kind === 'relocated') {
      // The container changed, so every root derived from the old one — the watcher target, allowed
      // roots, the prepared directory — has to be rebuilt from the new placement.
      const relocated = store.getRepo(repo.id) ?? repo
      void prepareLocalWorktreeRootForRepo(store, relocated)
      invalidateAuthorizedRootsCache()
      this.deps.invalidateResolvedWorktrees()
      this.deps.notifyReposChanged()
    }
    return toWireResult(repo.id, decision, outcome)
  }

  private requireStore(): RepoRelocationStore {
    const store = this.deps.getStore()
    if (!store?.relocateRepoPath || !store.migrateWorktreeIdentity) {
      throw new Error('runtime_unavailable')
    }
    return store
  }
}

/** Map the server-side plan/outcome unions onto the flat shape the wire carries. */
function toWireResult(
  repoId: string,
  decision: RelocationDecision,
  outcome?: RelocationOutcome
): RuntimeRepoRelocationResult {
  return {
    repoId,
    decision: decision.kind === 'ready' ? 'ready' : decision.reason,
    ...(decision.kind === 'ready' ? { plan: decision.plan } : {}),
    ...(outcome
      ? {
          outcome:
            outcome.kind === 'relocated'
              ? { kind: 'relocated', from: outcome.from, to: outcome.to }
              : { kind: outcome.reason }
        }
      : {})
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Why `dirname(to)`: the target does not exist yet, and `rename` cannot cross a volume. */
async function isSameVolume(from: string, to: string): Promise<boolean> {
  try {
    const [fromStats, targetParentStats] = await Promise.all([stat(from), stat(dirname(to))])
    return fromStats.dev === targetParentStats.dev
  } catch {
    // An unreadable path is not a volume answer, so refuse the move rather than assume one.
    return false
  }
}
