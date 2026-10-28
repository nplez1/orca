import {
  hasExplicitWorkspaceReviewSelection,
  getWorkspaceReviewPersistenceUpdates
} from './workspace-attachment-review-selection'
import {
  getWorkspaceAttachments,
  normalizeWorkspaceAttachmentUpdate
} from '../../../../../../shared/workspace-attachments'
import { normalizeGitHubPRSuppressionUpdate } from '../../../../../../shared/worktree/github-pr-suppression'
import type { WorktreeSlice } from '../../worktree-helpers'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import { translate } from '@/i18n/i18n'
import { isPositiveHostedReviewNumber } from '../../../../../../shared/hosted-review'
import { displayNameUpdatePinsLabel } from '../../../../../../shared/worktree/display-name-provenance'
import { parseWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../../../../shared/sidebar-inputs-switch'
import { applyWorktreeUpdates, getRepoIdFromWorktreeId } from '../../worktree-helpers'
import { getHostedReviewCacheKey } from '../../hosted-review-cache-identity'
import { getGitHubPRCacheKeyCandidates } from '../../../../../../shared/github/github-cache-key'
import {
  applyDetectedWorktreeUpdates,
  findKnownWorktreeById
} from '../listing/detected-worktree-meta'
import {
  bumpHostedReviewLinkMutationGeneration,
  hasChangedHostedReviewLinkUpdates,
  hasHostedReviewLinkUpdates
} from './hosted-review-link-mutation'
import {
  getHostedReviewPushTargetLookup,
  resolveGitHubReviewPushTarget
} from './hosted-review-push-target'
import { persistWorktreeMeta } from './worktree-meta-persist'
import { planWorktreeRename, settleWorktreeRename } from './worktree-rename-across-hosts'
import { updateFolderWorkspaceMeta } from './folder-workspace-meta-update'
import { refreshHostedReviewAfterMetaUpdate } from './refresh-hosted-review-after-meta-update'
import { withPendingSidebarRowWrites } from '@/lib/sidebar-pending-layer'
import { isRuntimeSelectorNotFoundError } from '../listing/runtime-worktree-rpc-errors'
import { runtimeTargetForWorktreeOwner } from '../listing/worktree-owner-target'
import { runtimeTargetForWorkspaceOwner } from '@/lib/resolve-owner'

import { findRepoForHost } from '../../repo-host-identity'
export function createUpdateWorktreeMeta(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['updateWorktreeMeta'] {
  const update: WorktreeSlice['updateWorktreeMeta'] = async (worktreeId, updates, options) => {
    const shouldApplyUpdate = options?.shouldApply
    const requestedHostId = options?.executionHostId
    const existingWorktree = findKnownWorktreeById(get(), worktreeId, requestedHostId)
    const executionHostId =
      requestedHostId ??
      existingWorktree?.hostId ??
      (get().settings?.activeRuntimeEnvironmentId ? undefined : 'local')
    if (shouldApplyUpdate && !shouldApplyUpdate(existingWorktree)) {
      return { ok: true }
    }
    const mutationUpdates =
      updates.linkedItems === undefined
        ? updates
        : {
            ...updates,
            linkedItems: updates.linkedItems,
            linkedItemsBase: updates.linkedItemsBase ?? getWorkspaceAttachments(existingWorktree),
            linkedItemsSelectionChanged:
              updates.linkedItemsSelectionChanged ?? hasExplicitWorkspaceReviewSelection(updates)
          }
    const workspaceScope = parseWorkspaceKey(worktreeId)
    if (workspaceScope?.type === 'folder') {
      return updateFolderWorkspaceMeta({
        state: get(),
        folderWorkspaceId: workspaceScope.folderWorkspaceId,
        updates: mutationUpdates,
        executionHostId
      })
    }
    let normalizedUpdates = normalizeWorkspaceAttachmentUpdate(existingWorktree, mutationUpdates)
    // Why: manual PR linking supplies only the number; resolve the head branch so Push targets the review branch.
    const linkedPrForPushTarget = isPositiveHostedReviewNumber(normalizedUpdates.linkedPR)
      ? normalizedUpdates.linkedPR
      : null
    // Why: an ambiguous owner must not throw past this update's { ok, error } contract — skip the lookup instead.
    const pushTargetOwner =
      linkedPrForPushTarget !== null &&
      normalizedUpdates.pushTarget === undefined &&
      existingWorktree &&
      !existingWorktree.pushTarget
        ? runtimeTargetForWorkspaceOwner(get(), {
            workspaceId: worktreeId,
            ...(executionHostId ? { hostId: executionHostId } : {})
          })
        : null
    const resolvedPushTarget =
      pushTargetOwner && existingWorktree && linkedPrForPushTarget !== null
        ? await resolveGitHubReviewPushTarget(
            pushTargetOwner,
            existingWorktree.repoId,
            linkedPrForPushTarget
          )
        : undefined
    const worktreeForUpdate = get().getKnownWorktreeById(worktreeId, executionHostId)
    if (shouldApplyUpdate && !shouldApplyUpdate(worktreeForUpdate)) {
      return { ok: true }
    }
    normalizedUpdates = normalizeGitHubPRSuppressionUpdate(
      normalizeWorkspaceAttachmentUpdate(worktreeForUpdate, mutationUpdates)
    )
    const currentResolvedPushTarget =
      normalizedUpdates.linkedPR === linkedPrForPushTarget ? resolvedPushTarget : undefined
    const existingHostedReviewPushTargetLookup = worktreeForUpdate
      ? getHostedReviewPushTargetLookup(worktreeForUpdate)
      : null
    const nextHostedReviewPushTargetLookup = worktreeForUpdate
      ? getHostedReviewPushTargetLookup({ ...worktreeForUpdate, ...normalizedUpdates })
      : null
    // A lookup can finish after another editor changes the selected review.
    const shouldClearStaleHostedReviewPushTarget =
      Boolean(worktreeForUpdate?.pushTarget) &&
      normalizedUpdates.pushTarget === undefined &&
      currentResolvedPushTarget === undefined &&
      existingHostedReviewPushTargetLookup !== null &&
      existingHostedReviewPushTargetLookup.key !== nextHostedReviewPushTargetLookup?.key
    const shouldRefreshHostedReview = Boolean(
      worktreeForUpdate && hasChangedHostedReviewLinkUpdates(normalizedUpdates, worktreeForUpdate)
    )
    const reviewRepo = shouldRefreshHostedReview
      ? (findRepoForHost(get().repos, worktreeForUpdate?.repoId ?? '', {
          hostId: executionHostId,
          settings: get().settings
        }) ?? undefined)
      : undefined
    const reviewBranch = worktreeForUpdate?.branch.replace(/^refs\/heads\//, '')

    // Why: bump lastActivityAt on comment edits so the time-decay sort doesn't drop a just-touched worktree.
    const displayNameProvenance =
      'displayName' in normalizedUpdates
        ? { displayNameIsPinned: displayNameUpdatePinsLabel(normalizedUpdates.displayName) }
        : {}
    const targetEnriched = currentResolvedPushTarget
      ? { ...normalizedUpdates, ...displayNameProvenance, pushTarget: currentResolvedPushTarget }
      : shouldClearStaleHostedReviewPushTarget
        ? { ...normalizedUpdates, ...displayNameProvenance, pushTarget: undefined }
        : { ...normalizedUpdates, ...displayNameProvenance }
    const renameCleared =
      'displayName' in targetEnriched
        ? {
            ...targetEnriched,
            pendingFirstAgentMessageRename: false,
            firstAgentMessageRenameError: null
          }
        : targetEnriched
    // Switch point: a comment edit is not a Recent event once the host owns the stamps.
    const enriched =
      'comment' in renameCleared && !ORCA_SIDEBAR_INPUTS_IS_MAIN
        ? { ...renameCleared, lastActivityAt: Date.now() }
        : renameCleared
    // A name is the workspace's, not one host's copy of it: every host that publishes this
    // workspace is renamed; a host that refuses keeps its name and is reported.
    const renamePlan = planWorktreeRename(get(), worktreeId, enriched, executionHostId)

    let didApply = false
    set((s) => {
      if (
        shouldApplyUpdate &&
        !shouldApplyUpdate(findKnownWorktreeById(s, worktreeId, executionHostId))
      ) {
        return s
      }
      didApply = true
      // Why the plan first: a rename covers every same-id row, and only with the name itself — the
      // rest of a mixed update belongs to the host the user edited.
      const base = renamePlan ? renamePlan.applyOptimistic(s) : s
      const nextWorktrees = applyWorktreeUpdates(
        base.worktreesByRepo,
        worktreeId,
        enriched,
        executionHostId
      )
      const nextDetectedWorktrees = applyDetectedWorktreeUpdates(
        base.detectedWorktreesByRepo,
        worktreeId,
        enriched,
        executionHostId
      )
      const cacheKey =
        reviewRepo && reviewBranch
          ? getHostedReviewCacheKey(
              reviewRepo.path,
              reviewBranch,
              s.settings,
              reviewRepo.id,
              reviewRepo.connectionId,
              reviewRepo.executionHostId,
              true
            )
          : null
      const prCacheKeys =
        reviewRepo && reviewBranch ? getGitHubPRCacheKeyCandidates(reviewRepo, reviewBranch) : []
      const prCacheKey = prCacheKeys[0] ?? null
      const hostedReviewCache = s.hostedReviewCache ?? {}
      const prCache = s.prCache ?? {}
      if (
        nextWorktrees === s.worktreesByRepo &&
        nextDetectedWorktrees === s.detectedWorktreesByRepo &&
        !cacheKey &&
        !prCacheKey
      ) {
        return s
      }

      const nextHostedReviewCache =
        cacheKey && hostedReviewCache[cacheKey]
          ? (() => {
              const next = { ...hostedReviewCache }
              delete next[cacheKey]
              return next
            })()
          : hostedReviewCache
      const nextPRCache = prCacheKeys.some((key) => prCache[key])
        ? (() => {
            const next = { ...prCache }
            for (const key of prCacheKeys) {
              delete next[key]
            }
            return next
          })()
        : prCache

      return {
        ...(nextWorktrees !== s.worktreesByRepo
          ? { worktreesByRepo: nextWorktrees, sortEpoch: s.sortEpoch + 1 }
          : {}),
        ...(nextDetectedWorktrees !== s.detectedWorktreesByRepo
          ? { detectedWorktreesByRepo: nextDetectedWorktrees }
          : {}),
        ...(nextHostedReviewCache !== hostedReviewCache
          ? { hostedReviewCache: nextHostedReviewCache }
          : {}),
        ...(nextPRCache !== prCache ? { prCache: nextPRCache } : {})
      }
    })
    if (shouldApplyUpdate && !didApply) {
      return { ok: true }
    }
    if (hasHostedReviewLinkUpdates(enriched)) {
      bumpHostedReviewLinkMutationGeneration(worktreeId, worktreeForUpdate)
    }

    const writePrimary = (): Promise<void> =>
      persistWorktreeMeta(
        renamePlan?.primary?.target ??
          runtimeTargetForWorktreeOwner(get(), worktreeId, executionHostId),
        worktreeId,
        getWorkspaceReviewPersistenceUpdates(mutationUpdates, enriched),
        renamePlan?.primary?.hostId ?? executionHostId ?? existingWorktree?.hostId,
        worktreeForUpdate?.identity?.key
      )
    // Why with the rename plan: every host's write is started together, so a caller's own host that
    // refuses cannot leave the rest of the fleet unrenamed.
    const rename = renamePlan
      ? await settleWorktreeRename({ state: get(), worktreeId, plan: renamePlan, writePrimary })
      : null
    try {
      if (rename?.primaryError) {
        throw rename.primaryError.reason
      }
      // Why only outside a rename: the settlement already started and awaited the caller's write.
      if (!rename) {
        await writePrimary()
      }
      refreshHostedReviewAfterMetaUpdate({
        state: get(),
        options,
        reviewRepo,
        reviewBranch,
        review: { repoOwnerExecutionHostId: executionHostId ?? worktreeForUpdate?.hostId },
        targetEnriched,
        worktreeForUpdate
      })
    } catch (err) {
      if (isRuntimeSelectorNotFoundError(err)) {
        void get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId))
        return {
          ok: false,
          error: translate(
            'auto.store.slices.worktrees.c6cf133786',
            'This workspace is no longer available.'
          )
        }
      }
      console.error('Failed to update worktree meta:', err)
      void get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId))
      // Refetch reverted the optimistic write; report failure so callers do not close on an undone save.
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    if (rename?.failure) {
      set(rename.failure.revertPatch)
      return rename.failure.result
    }
    return { ok: true }
  }
  // A conditional write may not apply, so only an unconditional one shows ahead of main.
  return (worktreeId, updates, options) =>
    options?.shouldApply
      ? update(worktreeId, updates, options)
      : withPendingSidebarRowWrites(
          () => [
            {
              worktreeId,
              updates,
              executionHostId:
                options?.executionHostId ?? findKnownWorktreeById(get(), worktreeId)?.hostId
            }
          ],
          () => update(worktreeId, updates, options)
        )
}
