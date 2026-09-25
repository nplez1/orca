import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import React, { useRef, useEffect } from 'react'
import { translate } from '@/i18n/i18n'
import { CheckCircle2, AlertCircle, Clock3, Minus } from 'lucide-react'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  getHostedReviewMergeReadiness,
  type HostedReviewMergeMarker,
  type HostedReviewMergeReadinessInput
} from '@/components/hosted-review-merge-readiness'
import { getChecksPillTone, getChecksLabel } from '@/components/task-page-checks-pill'

// Why the marker's tone is not the pill's tone: the pill's colour reports CI, so painting
// "merge blocked" in it would put two meanings back into one signal. Same reason the reason
// itself is only ever named in the tooltip.
const MERGE_MARKER_CLASS: Record<Exclude<HostedReviewMergeMarker, 'none'>, string> = {
  checking: 'bg-muted-foreground/70',
  waiting: 'bg-status-warning',
  blocked: 'bg-destructive'
}

/**
 * A work item carries its CI roll-up as `checksSummary`, while the readiness helper takes the
 * `status` the card uses — so the two must be bridged explicitly. `none` means "no checks
 * configured", which is not a check status at all, so it maps to `undefined`.
 */
function checksStatusForWorkItem(item: GitHubWorkItem): HostedReviewMergeReadinessInput['status'] {
  const state = item.checksSummary?.state
  return state === undefined || state === 'none' ? undefined : state
}
export function PRChecksCell({
  item,
  onOpen,
  onLoadChecks
}: {
  item: GitHubWorkItem
  onOpen: () => void
  onLoadChecks: () => void
}): React.JSX.Element {
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (item.type !== 'pr' || item.checksSummary) {
      return
    }
    const node = triggerRef.current
    if (!node || typeof IntersectionObserver === 'undefined') {
      return
    }
    let requested = false
    const observer = new IntersectionObserver(
      (entries) => {
        if (requested || !entries.some((entry) => entry.isIntersecting)) {
          return
        }
        requested = true
        onLoadChecks()
        observer.disconnect()
      },
      {
        rootMargin: '160px 0px'
      }
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [item.checksSummary, item.type, onLoadChecks])
  if (item.type !== 'pr') {
    return (
      <span className="text-[11px] text-muted-foreground">
        {translate('auto.components.TaskPage.b1eaa18ace', 'Issue')}
      </span>
    )
  }
  const summary = item.checksSummary
  const Icon =
    summary?.state === 'success'
      ? CheckCircle2
      : summary?.state === 'failure'
        ? AlertCircle
        : summary?.state === 'pending'
          ? Clock3
          : Minus
  // Why: a green "Passing" pill reads as "this can merge", but checks are one requirement
  // a provider imposes. The blocker is named in the tooltip, and the row's Merge column
  // still owns the action. Nothing is claimed when the provider has not reported.
  const mergeReadiness = getHostedReviewMergeReadiness({
    ...item,
    status: checksStatusForWorkItem(item)
  })
  const mergeMarker = mergeReadiness.marker
  const tooltipLabel =
    mergeMarker === 'none'
      ? translate('auto.components.TaskPage.995dd6af9b', 'Open PR checks')
      : `${translate('auto.components.TaskPage.995dd6af9b', 'Open PR checks')} · ${mergeReadiness.reason}`
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          onFocus={onLoadChecks}
          onMouseEnter={onLoadChecks}
          onClick={(event) => {
            event.stopPropagation()
            onLoadChecks()
            onOpen()
          }}
          className={cn(
            'inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium transition hover:brightness-110',
            getChecksPillTone(item)
          )}
        >
          <Icon className="size-3" />
          <span className="truncate">{getChecksLabel(item)}</span>
          {mergeMarker === 'none' ? null : (
            <span
              aria-hidden="true"
              data-pr-merge-blocked-marker={mergeMarker}
              className={cn('size-1.5 shrink-0 rounded-full', MERGE_MARKER_CLASS[mergeMarker])}
            />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {tooltipLabel}
      </TooltipContent>
    </Tooltip>
  )
}
