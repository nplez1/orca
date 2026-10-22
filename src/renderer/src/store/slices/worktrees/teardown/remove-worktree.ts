import type { WorktreeSlice } from '../../worktree-helpers'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import type { RemoveWorktreeResult } from '../../../../../../shared/worktree/create-types'
import { getRepoIdFromWorktreeId } from '../../worktree-helpers'
import { parseExecutionHostId } from '../../../../../../shared/execution-host'
import { ensureHooksConfirmed } from '@/lib/ensure-hooks-confirmed'
import { runtimeTargetForOwnerEnvironment } from '../../../../runtime/runtime-client-target'
import { forgetHugeRepoWarningDismissalsForWorktrees } from '@/lib/source-control-huge-repo-warning-dismissals'
import { forgetWorktreeSleepIntent } from '@/lib/worktree-sleep-intent'
import { readIpcErrorDetail } from '@/lib/ipc-error'
import { isArchiveHookRemovalError } from '../../../../../../shared/worktree/archive-hook-removal-gate'
import {
  beginHostQualifiedRemoval,
  completeSameIdHostScopedRemoval,
  findWorktreeOnConfirmedHost,
  prepareHostScopedRemovalCompletion,
  refuseUnprovableRemoteHostRouting
} from './host-qualified-worktree-removal'
import { resolveSameIdSurvivingHostId } from './host-qualified-worktree-row-removal'
import {
  classifyWorktreeForceDeleteReason,
  getLockedWorktreeRemovalReason,
  isLockedWorktreeRemovalError
} from '../../../../../../shared/worktree/removal'
import { preservedBranchCleanupKey } from '../../../../../../shared/preserved-branch-cleanup'
import { getWorktreeDeleteStateKey } from './worktree-delete-state'
import { preservedBranchRuntimeTargetByCleanupKey } from './preserved-branch-cleanup-target'
import { pruneHostedReviewLinkMutationGenerations } from '../metadata/hosted-review-link-mutation'
import { rememberAuthoritativelyRemovedWorktrees } from '../listing/authoritative-worktree-removal-memory'
import { recordRemovedWorktreeSnapshotPrune } from './removed-worktree-snapshot-prune'
import { clearSessionCommitDraftForWorktree } from '@/lib/source-control-commit-draft-session'
import { dispatchWorktreeRemoval } from './dispatch-worktree-removal'
import { tearDownRemovedWorktreeRendererState } from './removed-worktree-renderer-teardown'
import { buildWorktreeRemovalSuccessResult } from './worktree-removal-result'
import { captureWorktreeStateBeforeRemoval } from './worktree-state-before-removal'
import { resolveWorktreeRemovalPreference } from './worktree-removal-preference'
import { completePreservedBranchCleanup } from './complete-preserved-branch-cleanup'
import { resolveLocalForgetRemovalFallback } from './local-forget-removal-fallback'
import type { EphemeralVmCleanupSummary } from '@/lib/ephemeral-vm-runtime-cleanup'
import { showUnreachableVmRemovalNotice } from './unreachable-vm-workspace-release'
import { refreshEphemeralVmRuntimesAfterMutation } from '@/hooks/useEphemeralVmRuntimes'

export function createRemoveWorktree(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['removeWorktree'] {
  return async (removalTarget, force, options) => {
    const worktreeId = removalTarget.id
    const policy = resolveWorktreeRemovalPreference(get().settings, force, options)
    // Why (STA-4343): this is the ONE chokepoint every delete entry point shares,
    // so host qualification is enforced here rather than at any single caller — a
    // guard bolted onto the sidebar would drift from the cleanup dialog's. The
    // caller confirmed ONE host's row; route at that host instead of the active
    // workspace's, which owns the same id elsewhere.
    const requiredExecutionHostId = removalTarget.executionHostId
    const start = beginHostQualifiedRemoval(
      get,
      worktreeId,
      requiredExecutionHostId,
      policy.forgetLocalOnly,
      options?.ignoreWorkspaceCleanupScanSurvivors === true
    )
    if (!start.ok) {
      return { ok: false, error: start.error }
    }
    const {
      removalRoute,
      hostId,
      removalGenerationGuard,
      sameIdSurvivingHostId: catalogSameIdSurvivingHostId
    } = start
    const sameIdSurvivingHostId =
      catalogSameIdSurvivingHostId ?? options?.sameIdSurvivingHostId ?? null
    const deleteStateKey = getWorktreeDeleteStateKey(get(), worktreeId, requiredExecutionHostId)
    set((s) => ({
      deleteStateByWorktreeId: {
        ...s.deleteStateByWorktreeId,
        [deleteStateKey]: {
          isDeleting: true,
          phase: 'deleting',
          ...(requiredExecutionHostId ? { executionHostId: requiredExecutionHostId } : {}),
          error: null,
          canForceDelete: false,
          forceDeleteReason: null
        }
      }
    }))

    try {
      // Why: forget-local touches no remote, so there's no archive hook to run or trust prompt needed.
      // Why `get`: same-repo local deletes start together, and one approval must cover the rest.
      const skipArchive = policy.forgetLocalOnly
        ? true
        : (await ensureHooksConfirmed(
            get,
            getRepoIdFromWorktreeId(worktreeId),
            'archive',
            hostId,
            removalRoute?.runtimeEnvironmentId
          )) === 'skip'

      const worktreeBeforeRemoval = findWorktreeOnConfirmedHost(
        get,
        worktreeId,
        requiredExecutionHostId
      )
      const beforeRemoval = captureWorktreeStateBeforeRemoval(get(), worktreeId, hostId)
      if (!policy.forgetLocalOnly) {
        removalGenerationGuard?.assertCurrent()
      }
      // Why: forget-local clears Orca's records via local IPC regardless of host — the remote is gone or unreachable.
      const target = runtimeTargetForOwnerEnvironment(removalRoute?.runtimeEnvironmentId ?? null)
      const unprovableRemoteRouting = policy.forgetLocalOnly
        ? null
        : refuseUnprovableRemoteHostRouting(get, worktreeId, target.kind)
      if (unprovableRemoteRouting) {
        throw new Error(unprovableRemoteRouting)
      }
      let removalResult: RemoveWorktreeResult
      let snapshotPruneHandledByLocalMain = policy.forgetLocalOnly || target.kind === 'local'
      // Set when the host never answered and Orca owns its machine, so the delete reports on it.
      let unreachableOrcaMachine = false
      const reportMachine = (cleanup: EphemeralVmCleanupSummary): void => {
        refreshEphemeralVmRuntimesAfterMutation()
        // Why: the release removed this VM's server from main's store, so a list still showing it
        // would keep a dead host — and its active environment — in front of the user.
        void get().hydrateRuntimeEnvironmentStatuses()
        showUnreachableVmRemovalNotice(cleanup)
      }
      try {
        removalResult = await dispatchWorktreeRemoval({
          worktreeId,
          hostId,
          force: policy.force,
          skipArchive,
          get,
          target,
          options: policy.options,
          assertCurrent: () => removalGenerationGuard?.assertCurrent()
        })
      } catch (error) {
        // Why an unreachable VM is handled even for a local-transport route: an SSH-connection-mode
        // VM is reached as `ssh:<runtime-owned target>`, and its delete fails the same way.
        const fallback = policy.forgetLocalOnly
          ? ({ kind: 'not-applicable' } as const)
          : await resolveLocalForgetRemovalFallback({
              error,
              worktreeId,
              hostId,
              requiredExecutionHostId,
              target,
              generationGuard: removalGenerationGuard,
              get,
              snapshotPruneBatchId: options?.snapshotPruneBatchId,
              worktreePath: worktreeBeforeRemoval?.path ?? worktreeId,
              allowFailedArchiveHook: options?.allowFailedArchiveHook === true
            })
        if (fallback.kind === 'not-applicable') {
          throw error
        }
        removalResult = fallback.result
        snapshotPruneHandledByLocalMain = true
        unreachableOrcaMachine = fallback.unreachableOrcaMachine
      }

      if (!snapshotPruneHandledByLocalMain) {
        await recordRemovedWorktreeSnapshotPrune({
          worktreeId,
          hostId,
          snapshotPruneBatchId: options?.snapshotPruneBatchId
        })
      }

      // Why (STA-4343): another host still owns this id, so the shared renderer
      // state (tabs, terminals, browsers) belongs to that live workspace — drop
      // only the confirmed host's row instead of tearing all of it down.
      //
      // The ephemeral VM is the exception — see completeSameIdHostScopedRemoval.
      if (requiredExecutionHostId) {
        const currentSameIdSurvivingHostId = resolveSameIdSurvivingHostId(
          get(),
          worktreeId,
          requiredExecutionHostId,
          options?.ignoreWorkspaceCleanupScanSurvivors === true
        )
        const confirmedSurvivingHostId = currentSameIdSurvivingHostId ?? sameIdSurvivingHostId
        if (confirmedSurvivingHostId) {
          const sameIdStillSurvives = prepareHostScopedRemovalCompletion(
            set,
            worktreeId,
            requiredExecutionHostId,
            confirmedSurvivingHostId,
            options?.ignoreWorkspaceCleanupScanSurvivors === true
          )
          if (sameIdStillSurvives) {
            return completeSameIdHostScopedRemoval({
              set,
              get,
              worktreeId,
              requiredExecutionHostId,
              removalResult,
              removalRoute,
              target,
              worktreeBeforeRemoval,
              suppressPreservedBranchToast: options?.suppressPreservedBranchToast === true,
              rowAlreadyDropped: true,
              ...(unreachableOrcaMachine ? { onRuntimeCleanup: reportMachine } : {})
            })
          }
        }
      }

      // Why: invalidate stale probes once deletion is authoritative, so an old toast can't mutate a same-path replacement.
      forgetHugeRepoWarningDismissalsForWorktrees([worktreeId])
      forgetWorktreeSleepIntent(worktreeId)
      // Why: forget-local is legal while the host is unreachable, so record the removal here too — otherwise an
      // in-flight metadata read that snapshotted this row re-appends it, and disconnected polls never drop it.
      if (hostId && parseExecutionHostId(hostId)?.kind === 'ssh') {
        rememberAuthoritativelyRemovedWorktrees(hostId, [worktreeId])
      }

      const worktreeDisplayName = worktreeBeforeRemoval?.displayName?.trim()
      if (worktreeDisplayName && hostId) {
        try {
          await window.api.automations?.snapshotWorkspaceName?.({
            workspaceId: worktreeId,
            hostId,
            displayName: worktreeDisplayName
          })
        } catch (error) {
          // Why: snapshotting automation labels is best-effort; a stale preload/test harness must not block removal.
          console.warn('Failed to snapshot automation workspace name:', error)
        }
      }

      const runtimeCleanup = await tearDownRemovedWorktreeRendererState({
        set,
        get,
        worktreeId,
        hostId,
        requiredExecutionHostId,
        beforeRemoval,
        catalogVersion: removalResult?.catalogVersion
      })
      // Why after the teardown: it is the pass that released (or failed to release) the machine, and
      // a notice that claims otherwise must not be shown for a delete that never got this far.
      if (unreachableOrcaMachine) {
        reportMachine(runtimeCleanup)
      }
      // Why: Source Control may be unmounted during deletion, so it can't be the only stale-draft cleanup path.
      clearSessionCommitDraftForWorktree(worktreeId)
      const preservedBranch = removalResult?.preservedBranch
      const cleanup = preservedBranch
        ? {
            worktreeId,
            branchName: preservedBranch.branchName,
            expectedHead: preservedBranch.head,
            ...(hostId ? { hostId } : {}),
            ...(removalRoute?.runtimeEnvironmentId
              ? { runtimeEnvironmentId: removalRoute.runtimeEnvironmentId }
              : {})
          }
        : null
      if (preservedBranch) {
        preservedBranchRuntimeTargetByCleanupKey.set(preservedBranchCleanupKey(cleanup!), {
          cleanup: cleanup!,
          target
        })
      }
      const branchCleanupOptions = {
        ...(hostId ? { hostId } : {}),
        ...(removalRoute?.runtimeEnvironmentId
          ? { runtimeEnvironmentId: removalRoute.runtimeEnvironmentId }
          : {})
      }
      const autoDeletedBranch = await completePreservedBranchCleanup({
        get,
        worktreeId,
        removalResult,
        worktreeBeforeRemoval,
        branchCleanupOptions,
        suppressToast: options?.suppressPreservedBranchToast === true
      })
      pruneHostedReviewLinkMutationGenerations([worktreeId])
      return buildWorktreeRemovalSuccessResult({
        // Why: an auto-deleted branch is gone, so the removal reports no preserved branch.
        preservedBranch:
          preservedBranch && cleanup && !autoDeletedBranch
            ? {
                ...preservedBranch,
                ...(cleanup.hostId ? { hostId: cleanup.hostId } : {}),
                ...(cleanup.runtimeEnvironmentId
                  ? { runtimeEnvironmentId: cleanup.runtimeEnvironmentId }
                  : {})
              }
            : null,
        remoteBranchCleanup: removalResult?.remoteBranchCleanup
      })
    } catch (err) {
      // Why: git refusing a non-force delete for dirty/untracked files is a handled user decision, not an app error.
      console.warn('Failed to remove worktree:', err)
      // The raw message arrives wrapped in Electron's IPC channel and class names; this string is
      // read by a user in a toast, and the refusal sentence has to lead it.
      const error = readIpcErrorDetail(err) ?? (err instanceof Error ? err.message : String(err))
      const forceDeleteReason = classifyWorktreeForceDeleteReason(
        error,
        policy.force,
        policy.options?.allowUnverifiedPtyStop === true
      )
      const locked = isLockedWorktreeRemovalError(error)
      // Why (#19334): the refusal is the only failure a retry can clear by waiving rather than by
      // fixing state, so the toast needs to know it may offer that choice.
      const canWaiveArchiveHook = isArchiveHookRemovalError(error)
      set((s) => ({
        deleteStateByWorktreeId: {
          ...s.deleteStateByWorktreeId,
          [deleteStateKey]: {
            isDeleting: false,
            ...(requiredExecutionHostId ? { executionHostId: requiredExecutionHostId } : {}),
            error,
            canForceDelete: forceDeleteReason !== null,
            forceDeleteReason,
            ...(canWaiveArchiveHook ? { canWaiveArchiveHook: true } : {}),
            ...(locked ? { lockReason: getLockedWorktreeRemovalReason(error) } : {})
          }
        }
      }))
      return { ok: false as const, error }
    }
  }
}
