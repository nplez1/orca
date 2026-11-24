import { worktreeRemovalLifetime } from '../../../workspaces/removal/worktree-removal-lifetime'
import { CheckoutIdentityRefusal } from '../../../workspaces/removal/worktree-removal-leftover'
import type { GitPushTarget, GitWorktreeInfo } from '../../../../shared/worktree/types'
import {
  nativeWindowsMarkerMissing,
  usesNativeWindowsRemoval
} from '../../../git/worktrees/removal/windows-worktree-removal'
import { pruneGitWorktrees } from '../../../git/worktrees/removal/worktree-prune-guard'
import type { RemoveWorktreeResult } from '../../../../shared/worktree/create-types'
import { gateWorktreeRemovalOnArchiveHook } from '../../../workspaces/removal/worktree-archive-hook-gate'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { LocalProjectWorktreeGitOptions } from '../../../workspaces/execution-host/project-runtime-git-options'
import { removeWorktree } from '../../../git/worktrees/removal/worktree-removal'
import { getConfiguredWorktreeIncludePaths } from '../../../git/worktrees/content-paths/worktree-include-file'
import { runHook, getEffectiveHooks } from '../../../workspace-hooks/hooks'
import { removeWorktreeLinkedPaths } from '../../../ipc/worktrees/linked-paths/worktree-symlinks'
import { getWorktreeSharedLinkPaths } from '../../../git/worktrees/content-paths/worktree-shared-directories'
import { prepareRegisteredLocalWorktreeRemoval } from '../../../ipc/worktrees/removal/registered-local-worktree-preflight'
import { cleanupRemovedWorktreePushTarget } from './runtime-worktree-push-target-cleanup'
export { cleanupRemovedWorktreePushTarget } from './runtime-worktree-push-target-cleanup'
import { removeStaleWorktreeMaterializationStagingDirectories } from '../../../ipc/worktree-materialization-staging'
import { runWorktreeChangeInvalidators } from '../../../ipc/worktrees/listing/worktree-change-invalidators'
import {
  formatWorktreeRemovalError,
  isOrphanedWorktreeError
} from '../../../ipc/worktrees/paths/worktree-logic'
import { cleanupLocalOrphanedWorktreeDirectory } from '../../../workspaces/removal/local-orphaned-worktree-cleanup'
import { recoverPartialLocalWorktreeRemoval } from '../../../workspaces/removal/local-worktree-removal-recovery'
import type { RuntimePreservedBranchCleanup } from '../../repositories/runtime-preserved-branch-cleanup'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import type { RuntimeWorktreeRemovalTarget } from '../catalog/runtime-worktree-selection'
import {
  removesInBackground,
  startBackgroundWorktreeRemoval,
  waitForPendingWorktreeRemoval,
  waitForWorktreeRemovalAcceptance
} from '../../../workspaces/removal/worktree-background-removal'
import { runSerializedWorktreeRemovalAcceptance } from '../../../workspaces/removal/worktree-removal-acceptance-queue'
import { withRemovalAcceptanceFields } from '../../../worktree-removal-acceptance-fields'

/** Runs after the previous same-repo removal was accepted; see runSerializedWorktreeRemovalAcceptance. */
export function removeRuntimeRegisteredLocalWorktree(
  args: Parameters<typeof acceptRuntimeRegisteredLocalWorktreeRemoval>[0]
): Promise<RemoveWorktreeResult & { warning?: string }> {
  return runSerializedWorktreeRemovalAcceptance(
    args.repo.path,
    async (): Promise<RemoveWorktreeResult & { warning?: string }> => {
      // Recheck after queue wait: another client may already have accepted this deletion.
      if (waitForPendingWorktreeRemoval(args.target.id, undefined, args.requestedDeleteBranch)) {
        await waitForWorktreeRemovalAcceptance(args.target.id)
        return { removing: true }
      }
      return acceptRuntimeRegisteredLocalWorktreeRemoval(args)
    }
  )
}

async function acceptRuntimeRegisteredLocalWorktreeRemoval(args: {
  repo: Repo
  target: RuntimeWorktreeRemovalTarget
  registeredWorktree: GitWorktreeInfo
  removedPushTarget: GitPushTarget | undefined
  store: RuntimeStore
  localOptions: LocalProjectWorktreeGitOptions
  hasLocalOptions: boolean
  force: boolean
  runHooks: boolean
  /** Explicit waiver for a FAILED archive hook. Never implied by `force` — see #19334. */
  allowFailedArchiveHook: boolean
  allowUnverifiedPtyStop: boolean
  deleteBranch: boolean
  /** Opt-in `git push --delete` of the branch's upstream; paired with the local branch delete. */
  deleteRemoteBranch: boolean
  /** Legacy callers join accepted policy; explicit requests must match it. */
  requestedDeleteBranch?: boolean
  acquireWatcherRemoval: (path: string) => Promise<{ finish: (removed: boolean) => Promise<void> }>
  stopPtys: () => Promise<void>
  /** Runs after every refusal and the teardown, before any checkout file is deleted. */
  beforeCheckoutDelete?: (worktree: GitWorktreeInfo) => Promise<void>
  closeWatchers: (path: string) => Promise<void>
  preserveBranchHead: RuntimePreservedBranchCleanup['preserveHead']
  finishRemoval: (
    result: RemoveWorktreeResult | undefined,
    rememberBranch: boolean,
    // Archive hooks may move the branch; re-read the fallback head afterward.
    fallbackHead: string | undefined
  ) => void | Promise<void>
  /** Fired when Git finished, not on acceptance. */
  onRemoved: () => void
  publish: () => void
}): Promise<RemoveWorktreeResult & { warning?: string }> {
  const { repo, registeredWorktree, localOptions } = args
  const canonicalPath = registeredWorktree.path
  const hooks = getEffectiveHooks(repo)
  // What acceptance alone contributes to the result; Git's finish can add more, and neither may be lost.
  const acceptedFields: RemoveWorktreeResult = {}
  if (
    hooks?.scripts.archive &&
    args.runHooks &&
    !(await nativeWindowsMarkerMissing(canonicalPath, localOptions))
  ) {
    const result = await runHook(
      'archive',
      canonicalPath,
      repo,
      undefined,
      args.hasLocalOptions ? localOptions : undefined,
      { identity: { worktreeId: args.target.id } }
    )
    // Archive refusal precedes refresh, preflights, PTY stop and Git deletion; failure must leave them untouched (#19334).
    acceptedFields.archiveHookOverride = gateWorktreeRemovalOnArchiveHook({
      worktreePath: canonicalPath,
      result,
      allowFailure: args.allowFailedArchiveHook
    })
  } else if (hooks?.scripts.archive) {
    acceptedFields.warning = `orca.yaml archive hook skipped for ${canonicalPath}; pass --run-hooks to run it.`
    console.warn(`[hooks] ${acceptedFields.warning}`)
  }

  const linkedPaths = getWorktreeSharedLinkPaths(repo)
  const includePaths = await getConfiguredWorktreeIncludePaths(repo.path)
  await removeStaleWorktreeMaterializationStagingDirectories(canonicalPath, [
    ...linkedPaths,
    ...includePaths
  ])
  const { refreshed, guard, markerMissing } = await prepareRegisteredLocalWorktreeRemoval({
    repo,
    canonicalWorktreePath: canonicalPath,
    force: args.force,
    localOptions,
    hasLocalOptions: args.hasLocalOptions,
    linkedPaths
  })

  const background = removesInBackground(canonicalPath, localOptions)
  const prepare = async (): Promise<RemoveWorktreeResult> => {
    const gate = await args.acquireWatcherRemoval(canonicalPath)
    let accepted = false
    try {
      await args.stopPtys()
      if (args.beforeCheckoutDelete || (!markerMissing && linkedPaths.length > 0)) {
        await guard.verify()
      }
      await args.beforeCheckoutDelete?.(refreshed)
      if (!markerMissing && linkedPaths.length > 0) {
        await removeWorktreeLinkedPaths(canonicalPath, linkedPaths)
      }
      accepted = true
    } finally {
      if (!accepted) {
        await gate.finish(false)
      }
    }
    const runFinish = (stopSignal?: AbortSignal) =>
      finishRuntimeLocalWorktreeRemoval(
        args,
        refreshed,
        gate,
        stopSignal,
        guard.verify,
        guard.markerOptions
      )
    if (!background) {
      const result = await runFinish()
      args.publish()
      return withRemovalAcceptanceFields(result, acceptedFields)
    }
    // After all refusals, detach slow Git deletion so request timeout cannot cancel it; clients follow the removing marker.
    void startBackgroundWorktreeRemoval({
      removal: {
        worktreeId: args.target.id,
        repoId: repo.id,
        repoPath: repo.path,
        worktree: refreshed,
        gitdir: guard.gitdir,
        deleteBranch: args.deleteBranch,
        force: args.force
      },
      run: async (stopSignal) => {
        const result = await runFinish(stopSignal)
        args.onRemoved()
        return result
      },
      publish: () => args.publish(),
      admissionFailed: () => gate.finish(false)
    })
    await waitForWorktreeRemovalAcceptance(args.target.id)
    return { removing: true, ...acceptedFields }
  }
  return background ? worktreeRemovalLifetime.withPreparation(prepare) : prepare()
}

export type RuntimeLocalWorktreeRemovalFinishArgs = Pick<
  Parameters<typeof acceptRuntimeRegisteredLocalWorktreeRemoval>[0],
  | 'repo'
  | 'removedPushTarget'
  | 'store'
  | 'localOptions'
  | 'force'
  | 'deleteBranch'
  | 'deleteRemoteBranch'
  | 'closeWatchers'
  | 'preserveBranchHead'
  | 'finishRemoval'
> & { target: { id: string } }

/** Git's delete and everything after it; the refusals and teardown before it already ran. */
export async function finishRuntimeLocalWorktreeRemoval(
  args: RuntimeLocalWorktreeRemovalFinishArgs,
  refreshed: GitWorktreeInfo,
  gate: { finish: (removed: boolean) => Promise<void> },
  checkoutDeleteSignal?: AbortSignal,
  beforeCheckoutDelete?: () => Promise<void>,
  markerOptions: { expectedMarker?: string; forbidAnyMarker?: boolean } = {}
): Promise<RemoveWorktreeResult> {
  const { repo, localOptions } = args
  const canonicalPath = refreshed.path
  const native = usesNativeWindowsRemoval(canonicalPath, localOptions)
  const hasInlineGuard =
    markerOptions.expectedMarker !== undefined || markerOptions.forbidAnyMarker === true
  let removalResult: RemoveWorktreeResult | undefined
  let completed = false
  try {
    try {
      removalResult = args.preserveBranchHead(
        await removeWorktree(repo.path, canonicalPath, args.force, {
          ...(!args.deleteBranch ? { deleteBranch: args.deleteBranch } : {}),
          ...(args.deleteRemoteBranch ? { deleteRemoteBranch: true } : {}),
          knownRemovedWorktree: refreshed,
          ...localOptions,
          ...markerOptions,
          ...(checkoutDeleteSignal ? { checkoutDeleteSignal } : {}),
          ...(beforeCheckoutDelete ? { beforeCheckoutDelete } : {})
        }),
        refreshed.head
      )
    } catch (error) {
      // A refused identity check deleted nothing; recovery must not delete someone else's folder.
      if (error instanceof CheckoutIdentityRefusal || native) {
        throw error
      }
      const recovered = await recoverPartialLocalWorktreeRemoval({
        error,
        force: args.force,
        canonicalWorktreePath: canonicalPath,
        repoPath: repo.path,
        localWorktreeGitOptions: localOptions,
        registeredWorktree: refreshed,
        deleteBranch: args.deleteBranch,
        closeWatcher: args.closeWatchers,
        signal: checkoutDeleteSignal,
        ...markerOptions,
        ...(!hasInlineGuard && beforeCheckoutDelete
          ? { beforeLeftoverDelete: beforeCheckoutDelete }
          : {})
      })
      if (recovered) {
        removalResult = recovered
        completed = true
      } else if (isOrphanedWorktreeError(error)) {
        await beforeCheckoutDelete?.()
        await cleanupLocalOrphanedWorktreeDirectory(
          repo.path,
          canonicalPath,
          localOptions,
          args.closeWatchers,
          checkoutDeleteSignal,
          markerOptions
        )
        await pruneGitWorktrees({ cwd: repo.path, ...localOptions }).catch(() => {})
        await cleanupRemovedWorktreePushTarget(args)
        await args.finishRemoval(undefined, false, refreshed.head)
        completed = true
        return {}
      } else {
        throw new Error(formatWorktreeRemovalError(error, canonicalPath, args.force))
      }
    }
    // Removal overtakes earlier scans; invalidate their catalogs.
    runWorktreeChangeInvalidators(repo.id)
    completed = true
    try {
      await cleanupRemovedWorktreePushTarget(args)
    } finally {
      // Awaited so the removal result lands only after the host-state purge (and
      // the Codex pretrust deletion inside it) has finished.
      await args.finishRemoval(removalResult, true, refreshed.head)
    }
    return removalResult ?? {}
  } finally {
    await gate.finish(completed)
  }
}
