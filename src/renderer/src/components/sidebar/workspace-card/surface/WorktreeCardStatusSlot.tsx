import { getProviderChecksOutcome } from '../../../../../../shared/source-control/checks/provider-check-summary'
import React from 'react'
import { Bell, GitBranch, Moon } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import {
  getHostedReviewMergeReadiness,
  hostedReviewMergeVerdictLabel
} from '@/components/hosted-review-merge-readiness'
import { cn } from '@/lib/class-names'
import { observeOffscreenAnimation } from '@/lib/window-activity/offscreen-animation-pause'
import {
  getWorktreeStatusLabel,
  type WorktreeStatus
} from '@/lib/workspace/activity/worktree-status'
import '../activity/worktree-card-empty-inputs'
import { FilledBellIcon } from '../identity/worktree-card-glyphs'
import { checksLabel } from '../review/workspace-review-check-label'
import StatusIndicator from './StatusIndicator'
import { useWorktreeActivityStatus } from '../activity/use-worktree-activity-status'
import { laneStatusWithLineage } from './worktree-card-lineage-lane-status'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store/index'
import {
  selectEphemeralVmWorkspaceRuntime,
  selectEphemeralVmWorkspaceWaking
} from '@/store/slices/ephemeral-vm/ephemeral-vm-lifecycle'
import { selectIsSleepingWorktree } from '../../workspace-actions/sleep/use-worktree-sleep-state'
import { getEphemeralVmHostState } from '../../../../../../shared/execution-host/execution-host-health'
import { getVmStateLabel, VmStateIcon, WorktreeCardVmStateBadge } from './WorktreeCardVmStateBadge'
import type { WorktreeCardPrDisplay } from '../review/worktree-card-pr-display'
import {
  getReviewLabel,
  ReviewIconWithMergeMarker,
  STALE_REVIEW_SHIMMER
} from '../review/worktree-review-presentation'
import { handleShimmerAnimationStart } from '@/components/ui/shared-animation-clock'
import type { WorkspaceReviewChecksSummary } from '../../../../../../shared/workspace-attachments/workspace-review-checks'
import {
  WorkspaceReviewChecksIndicator,
  workspaceReviewChecksLabel
} from '../../workspace-status/presentation/WorkspaceReviewChecksIndicator'

type WorktreeCardStatusSlotProps = {
  worktreeId: string
  /** Replaces the live activity status, for rows that fold it (bots). */
  status?: WorktreeStatus
  showStatus: boolean
  showUnreadAction: boolean
  isUnread: boolean
  /** A collapsed descendant's needs-you, failed or working state; replaces a quieter own status. */
  lineageStatus?: WorktreeStatus | null
  unreadTooltip: string
  onToggleUnread: React.MouseEventHandler<HTMLButtonElement>
  onPointerDown: React.PointerEventHandler<HTMLButtonElement>
  prDisplay?: WorktreeCardPrDisplay | null
  reviewChecks?: WorkspaceReviewChecksSummary
  newCardStyle?: boolean
  hasBranchIdentity?: boolean
  branchIdentityLabel?: string
  /** The review status is the last known one (its WSL host is off). */
  reviewStale?: boolean
  className?: string
}

const QUIET_REVIEW_REPLACEABLE_STATUSES = new Set<WorktreeStatus>(['active', 'done', 'inactive'])
// Missing provider state cannot prove no review exists; label only the branch identity.
function getDefaultBranchIdentityLabel(t: Translate = translate): string {
  return t('auto.components.sidebar.WorktreeCardStatusSlot.branchIdentity', 'Branch')
}
function getSleepingStatusLabel(t: Translate = translate): string {
  return t('auto.components.sidebar.WorktreeCardStatusSlot.sleeping', 'Sleeping')
}
// Offset optically left-heavy branch glyphs to align with centered activity dots.
const compactReviewAndBranchStatusIconClassName = 'size-[13px] translate-x-px'
export const branchStatusIconClassName = `${compactReviewAndBranchStatusIconClassName} text-muted-foreground opacity-70 forced-colors:opacity-100`
// The whole sleeping row is dimmed; extra glyph tint would double-dim it.
const sleepingStatusIconClassName = 'size-[13px] text-muted-foreground'
// Overlay unread on the glyph's corner without widening the lane; the ring separates it from busy glyphs.
// Blue, not amber: the lane already spends yellow and orange on working, pending checks and needs-you.
export const unreadAlertDotClassName =
  'pointer-events-none absolute right-0 bottom-0 size-[6px] rounded-full bg-unread ring-2 ring-worktree-sidebar'

export function getUnreadToggleTooltip(isUnread: boolean): string {
  return isUnread
    ? translate('auto.components.sidebar.useWorktreeCardWorkspaceActions.markRead', 'Mark read')
    : translate('auto.components.sidebar.useWorktreeCardWorkspaceActions.markUnread', 'Mark unread')
}

export function overlayNewCardUnreadStatus(
  status: React.JSX.Element,
  showUnreadAlert: boolean
): React.JSX.Element {
  if (!showUnreadAlert) {
    return status
  }

  return (
    <span
      data-worktree-status-lane-unread=""
      className="relative inline-flex size-5 shrink-0 items-center justify-center"
    >
      {status}
      <span data-worktree-unread-alert="" className={unreadAlertDotClassName} aria-hidden="true" />
    </span>
  )
}

function getReviewStatusLabel(review: WorktreeCardPrDisplay, t: Translate = translate): string {
  const settled = review.state === 'merged' || review.state === 'closed' || review.state === 'draft'
  const base = settled
    ? getReviewStateLabel(review, t)
    : (getReviewChecksLabel(review, t) ?? getReviewStateLabel(review, t))
  const mergeReason = getReviewMergeReason(review)
  return mergeReason ? `${base} · ${mergeReason}` : base
}

/** The review's own state, with no checks verdict — the collection summary owns that half. */
function getReviewStateLabel(review: WorktreeCardPrDisplay, t: Translate = translate): string {
  const values = { review: getReviewLabel(review) }
  if (review.state === 'merged') {
    return t('workspace.reviewStatus.merged', '{{review}}: Merged', values)
  }
  if (review.state === 'closed') {
    return t('workspace.reviewStatus.closed', '{{review}}: Closed', values)
  }
  if (review.state === 'draft') {
    return t('workspace.reviewStatus.draft', '{{review}}: Draft', values)
  }
  return t('workspace.reviewStatus.open', '{{review}}: Open', values)
}

/** This one review's checks verdict. Stated only when no collection summary covers it. */
function getReviewChecksLabel(
  review: WorktreeCardPrDisplay,
  t: Translate = translate
): string | null {
  const values = { review: getReviewLabel(review) }
  const outcome = review.status
    ? getProviderChecksOutcome(review.checksSummary, review.status)
    : undefined
  if (outcome === 'cancelled') {
    return `${getReviewLabel(review)}: ${checksLabel(outcome, t)}`
  }
  if (outcome === 'failure') {
    return t('workspace.reviewStatus.checksFailed', '{{review}} checks: Failed', values)
  }
  if (outcome === 'pending') {
    return t('workspace.reviewStatus.checksPending', '{{review}} checks: Pending', values)
  }
  if (outcome === 'success') {
    return t('workspace.reviewStatus.checksPassing', '{{review}} checks: Passing', values)
  }
  return null
}

/** The merge blocker on its own, formed so a card whose checks the collection summary already
 *  states can still name what is holding the merge back. */
function getReviewMergeReason(review: WorktreeCardPrDisplay): string | null {
  // Why: the marker says "not mergeable yet" without saying why, and this label is the only
  // place the specific blocker is named — so it has to reach the tooltip and the screen-reader
  // text. Null when the checks half of this same label already says it, or when the provider
  // has not reported a merge state to report.
  return hostedReviewMergeVerdictLabel(getHostedReviewMergeReadiness(review))
}

export function WorktreeCardStatusSlot({
  worktreeId,
  status: statusOverride,
  showStatus,
  showUnreadAction,
  isUnread,
  lineageStatus = null,
  unreadTooltip,
  onToggleUnread,
  onPointerDown,
  prDisplay = null,
  reviewChecks,
  newCardStyle = false,
  hasBranchIdentity = false,
  branchIdentityLabel,
  reviewStale = false,
  className
}: WorktreeCardStatusSlotProps): React.JSX.Element | null {
  const t = useTranslate()
  const collectionChecks = reviewChecks && reviewChecks.total > 1 ? reviewChecks : undefined
  const isReviewStale = reviewStale || Boolean(collectionChecks?.stale)
  const liveStatus = laneStatusWithLineage(useWorktreeActivityStatus(worktreeId), lineageStatus)
  const status = statusOverride ?? liveStatus
  // One subscription per card: rows mount by the hundreds, and every listener runs on each store write.
  const { isSleeping, vmRuntime, vmWaking } = useAppStore(
    useShallow((state) => ({
      isSleeping: selectIsSleepingWorktree(state, worktreeId),
      vmRuntime: selectEphemeralVmWorkspaceRuntime(state, worktreeId),
      vmWaking: selectEphemeralVmWorkspaceWaking(state, worktreeId)
    }))
  )
  const vmState = vmRuntime ? getEphemeralVmHostState(vmRuntime.status, vmWaking) : null
  const vmFailure = vmRuntime?.failure ?? null
  const statusLabel = getWorktreeStatusLabel(status) || status
  // Sleeping remains distinct from quiet done/branch/review states; attention keeps its own glyph.
  const canShowSleepingStatus =
    newCardStyle && showStatus && isSleeping && QUIET_REVIEW_REPLACEABLE_STATUSES.has(status)
  const canShowReviewStatus =
    newCardStyle &&
    showStatus &&
    (prDisplay !== null || Boolean(collectionChecks)) &&
    !canShowSleepingStatus &&
    QUIET_REVIEW_REPLACEABLE_STATUSES.has(status)
  const canShowBranchStatus =
    newCardStyle &&
    showStatus &&
    hasBranchIdentity &&
    prDisplay === null &&
    !collectionChecks &&
    !canShowSleepingStatus &&
    QUIET_REVIEW_REPLACEABLE_STATUSES.has(status)
  const passiveStatusLabel = canShowSleepingStatus
    ? getSleepingStatusLabel(t)
    : canShowReviewStatus && collectionChecks
      ? `${workspaceReviewChecksLabel(collectionChecks, t)}${
          // Why: the summary states every attached review's checks, so restating one review's
          // verdict beside it contradicts it. The merge blocker is a separate axis and stays.
          prDisplay ? (getReviewMergeReason(prDisplay) ?? '') : ''
        }`
      : canShowReviewStatus && prDisplay
        ? getReviewStatusLabel(prDisplay, t)
        : canShowBranchStatus
          ? (branchIdentityLabel ?? getDefaultBranchIdentityLabel(t))
          : statusLabel
  const reviewLabel =
    isReviewStale && canShowReviewStatus && (collectionChecks || prDisplay)
      ? `${passiveStatusLabel} · ${t('workspace.links.lastKnownStatus', 'Last known status')}`
      : passiveStatusLabel
  const passiveStatusAnnouncement =
    newCardStyle && isUnread
      ? t('workspace.activity.unreadLabel', '{{status}} · Unread', { status: reviewLabel })
      : reviewLabel
  // The lane holds the card's only unread dot (agent rows and the folded pill draw none), so it
  // stays on over working/permission glyphs; the corner ring keeps it legible against them.
  const showNewCardUnreadAlert = newCardStyle && isUnread && showStatus
  const reviewStaleProps = isReviewStale
    ? { ref: observeOffscreenAnimation, onAnimationStart: handleShimmerAnimationStart }
    : undefined
  const reviewStatusIconClassName = cn(
    compactReviewAndBranchStatusIconClassName,
    // Same last-known treatment as the hover card's reference rows.
    isReviewStale && STALE_REVIEW_SHIMMER
  )
  const branchStatusIcon = <GitBranch className={branchStatusIconClassName} aria-hidden="true" />
  const sleepingStatusIcon = <Moon className={sleepingStatusIconClassName} aria-hidden="true" />
  const passiveStatus = canShowSleepingStatus ? (
    <span className={cn('inline-flex size-5 items-center justify-center p-0.5', className)}>
      {sleepingStatusIcon}
      <span className="sr-only">{passiveStatusAnnouncement}</span>
    </span>
  ) : canShowReviewStatus && (collectionChecks || prDisplay) ? (
    <span
      {...reviewStaleProps}
      className={cn('inline-flex size-5 items-center justify-center p-0.5', className)}
    >
      {collectionChecks ? (
        <WorkspaceReviewChecksIndicator
          summary={collectionChecks}
          className={reviewStatusIconClassName}
        />
      ) : prDisplay ? (
        <ReviewIconWithMergeMarker
          review={prDisplay}
          className={reviewStatusIconClassName}
          variant="generic"
        />
      ) : null}
      <span className="sr-only">{passiveStatusAnnouncement}</span>
    </span>
  ) : canShowBranchStatus ? (
    <span className={cn('inline-flex size-5 items-center justify-center p-0.5', className)}>
      {branchStatusIcon}
      <span className="sr-only">{passiveStatusAnnouncement}</span>
    </span>
  ) : newCardStyle && showStatus ? (
    <>
      <span className={cn('inline-flex size-5 items-center justify-center', className)}>
        <StatusIndicator status={status} aria-hidden="true" tooltipSide="right" />
      </span>
      <span className="sr-only">{passiveStatusAnnouncement}</span>
    </>
  ) : (
    <>
      <StatusIndicator
        status={status}
        aria-hidden="true"
        className={className}
        tooltipSide="right"
      />
      <span className="sr-only">{statusLabel}</span>
    </>
  )

  const unreadActionEnabled = showUnreadAction && !newCardStyle

  if (!showStatus && !unreadActionEnabled) {
    return null
  }

  // A VM that is not running cannot have live activity; its lifecycle is the row's status.
  // The classic card's unread toggle keeps its button and shows the VM state inside it.
  if (vmState && showStatus && !unreadActionEnabled) {
    return overlayNewCardUnreadStatus(
      <WorktreeCardVmStateBadge
        state={vmState}
        failure={vmFailure}
        // The classic card's status lane is 16px; match it so titles stay aligned.
        className={cn(!newCardStyle && 'size-4 p-0', className)}
      />,
      newCardStyle && isUnread
    )
  }

  if (!unreadActionEnabled) {
    return overlayNewCardUnreadStatus(passiveStatus, showNewCardUnreadAlert)
  }

  const actionLabel = isUnread
    ? t('auto.components.sidebar.WorktreeCardStatusSlot.markAsRead', 'Mark as read')
    : t('auto.components.sidebar.WorktreeCardStatusSlot.markAsUnread', 'Mark as unread')
  const statusTooltipLabel = vmState ? getVmStateLabel(vmState, t) : passiveStatusLabel
  // A running or blocked turn is newer than the prior turn's unread, so it keeps its glyph and the bell becomes a dot.
  // Monitoring keeps the bell: that turn has ended and its result is waiting for the user.
  const showsUnreadBell =
    isUnread && !(showStatus && !vmState && (status === 'working' || status === 'permission'))
  const tooltip =
    showStatus && !showsUnreadBell ? `${statusTooltipLabel} · ${unreadTooltip}` : unreadTooltip

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-workspace-board-preserve-open=""
            onPointerDown={onPointerDown}
            onClick={onToggleUnread}
            className={cn(
              'group/unread relative flex cursor-pointer items-center justify-center rounded transition-all',
              newCardStyle && showStatus ? 'size-5' : 'size-4',
              'hover:bg-accent/80 active:scale-95',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              className
            )}
            aria-label={actionLabel}
          >
            {newCardStyle ? (
              showStatus && canShowReviewStatus && prDisplay ? (
                <span
                  {...reviewStaleProps}
                  className="inline-flex size-5 items-center justify-center p-0.5"
                >
                  <ReviewIconWithMergeMarker
                    review={prDisplay}
                    className={reviewStatusIconClassName}
                    variant="generic"
                  />
                </span>
              ) : showStatus && canShowBranchStatus ? (
                <span className="inline-flex size-5 items-center justify-center p-0.5">
                  {branchStatusIcon}
                </span>
              ) : showStatus ? (
                <StatusIndicator status={status} aria-hidden="true" showTooltip={false} />
              ) : (
                <span className="sr-only">{actionLabel}</span>
              )
            ) : showsUnreadBell ? (
              <FilledBellIcon className="size-[13px] text-unread-bell drop-shadow-sm" />
            ) : showStatus ? (
              <>
                {vmState ? (
                  <span className="inline-flex transition-opacity group-hover/unread:opacity-0 group-focus-within/unread:opacity-0">
                    <VmStateIcon state={vmState} />
                  </span>
                ) : (
                  <StatusIndicator
                    status={status}
                    aria-hidden="true"
                    showTooltip={false}
                    className="transition-opacity group-hover/unread:opacity-0 group-focus-within/unread:opacity-0"
                  />
                )}
                {isUnread ? (
                  <>
                    <FilledBellIcon className="absolute size-[13px] text-unread-bell opacity-0 drop-shadow-sm transition-opacity group-hover/unread:opacity-100 group-focus-within/unread:opacity-100" />
                    <span
                      data-worktree-unread-alert=""
                      className={cn(
                        unreadAlertDotClassName,
                        'transition-opacity group-hover/unread:opacity-0 group-focus-within/unread:opacity-0'
                      )}
                      aria-hidden="true"
                    />
                  </>
                ) : (
                  <Bell className="absolute size-3 text-muted-foreground/40 opacity-0 transition-opacity group-hover/unread:opacity-100 group-focus-within/unread:opacity-100" />
                )}
              </>
            ) : (
              <Bell className="size-3 text-muted-foreground/40 can-hover:opacity-0 transition-opacity group-hover:opacity-100 group-hover/unread:opacity-100 group-focus-within/unread:opacity-100" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>
          <span>{tooltip}</span>
        </TooltipContent>
      </Tooltip>
      {showStatus && <span className="sr-only">{vmState ? statusTooltipLabel : statusLabel}</span>}
    </>
  )
}
