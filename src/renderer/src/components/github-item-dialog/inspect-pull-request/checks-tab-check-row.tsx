import React from 'react'
import { ChevronDown, CircleDashed } from 'lucide-react'
import { cn } from '@/lib/utils'
import { CHECK_COLOR, CHECK_ICON } from '@/components/right-sidebar/checks-panel/check-presentation'
import type { CheckDetailsLoadState } from '@/components/github-checks-tab-state'
import type { PRCheckDetail } from '../../../../../shared/github/check-types'
import { getCheckConclusion } from '@/components/pr-check-counts'
import { getCheckDetailsKey, getCheckStatusLabel } from '@/components/github/pr-check-presentation'
import { JenkinsRebuildButton } from '@/components/jenkins-rebuild-button'
import { ChecksTabCheckDetails } from './checks-tab-check-details'

export function renderCheckRow({
  check,
  variant,
  expandedCheckKey,
  detailsByCheckKey,
  onToggle,
  requestCheckDetails,
  onCheckRebuildStarted
}: {
  check: PRCheckDetail
  variant: 'compact' | 'page'
  expandedCheckKey: string | null
  detailsByCheckKey: Record<string, CheckDetailsLoadState | undefined>
  onToggle: (check: PRCheckDetail) => void
  requestCheckDetails: (check: PRCheckDetail, key: string) => void
  onCheckRebuildStarted?: () => void
}): React.JSX.Element {
  const key = getCheckDetailsKey(check)
  return (
    <ChecksTabCheckRow
      key={key}
      check={check}
      variant={variant}
      expanded={expandedCheckKey === key}
      detailsState={detailsByCheckKey[key]}
      onToggle={onToggle}
      onRetry={requestCheckDetails}
      {...(onCheckRebuildStarted ? { onCheckRebuildStarted } : {})}
    />
  )
}

export function ChecksTabCheckRow({
  check,
  variant,
  expanded,
  detailsState,
  onToggle,
  onRetry,
  onCheckRebuildStarted
}: {
  check: PRCheckDetail
  variant: 'compact' | 'page'
  expanded: boolean
  detailsState: CheckDetailsLoadState | undefined
  onToggle: (check: PRCheckDetail) => void
  onRetry: (check: PRCheckDetail, key: string) => void
  onCheckRebuildStarted?: () => void
}): React.JSX.Element {
  const conclusion = getCheckConclusion(check)
  const Icon = CHECK_ICON[conclusion] ?? CircleDashed
  const color = CHECK_COLOR[conclusion] ?? 'text-muted-foreground'
  const statusLabel = getCheckStatusLabel(check)
  return (
    <div className="min-w-0">
      <div
        className={cn(
          'flex w-full min-w-0 items-center gap-2 rounded-md transition',
          variant === 'page' ? 'px-3 py-1 hover:bg-accent/60' : 'px-2 py-0.5 hover:bg-muted/40'
        )}
      >
        <button
          type="button"
          onClick={() => onToggle(check)}
          aria-expanded={expanded}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2 text-left',
            variant === 'page' ? 'py-1.5' : 'py-1'
          )}
        >
          <ChevronDown
            className={cn(
              'size-3 shrink-0 text-muted-foreground transition-transform',
              !expanded && '-rotate-90'
            )}
          />
          <Icon
            className={cn('size-3.5 shrink-0', color, conclusion === 'pending' && 'animate-spin')}
          />
          <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">{check.name}</span>
          {/* Why inside the toggle: the whole row reads as one target, so the status in it has to
              open the details too rather than doing nothing. */}
          <span className="shrink-0 text-[11px] text-muted-foreground">{statusLabel}</span>
        </button>
        <JenkinsRebuildButton
          check={check}
          iconOnly
          {...(onCheckRebuildStarted ? { onStarted: onCheckRebuildStarted } : {})}
        />
      </div>
      {expanded ? (
        <ChecksTabCheckDetails
          check={check}
          state={detailsState}
          onRetry={onRetry}
          {...(onCheckRebuildStarted ? { onRebuildStarted: onCheckRebuildStarted } : {})}
        />
      ) : null}
    </div>
  )
}
