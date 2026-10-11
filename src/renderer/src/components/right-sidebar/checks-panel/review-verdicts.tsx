import React from 'react'
import {
  ArrowRight,
  CircleCheck,
  CircleDashed,
  CircleMinus,
  CircleX,
  MessageSquare
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { GitHubUserAvatar } from '@/components/github/github-user-avatar'
import type { GitHubReviewState } from '../../../../../shared/github/comment-types'
import type { PRReviewVerdict } from '../../../../../shared/pr-review-verdicts'
import { translate } from '@/i18n/i18n'

// Why: wording is settled by the merge-readiness badge, and the icon is what separates a change
// request from an approval for a reader who has not read the label yet. Colour never carries the
// verdict on its own.
const VERDICT_ICON: Record<GitHubReviewState, React.ComponentType<{ className?: string }>> = {
  CHANGES_REQUESTED: CircleX,
  APPROVED: CircleCheck,
  COMMENTED: MessageSquare,
  DISMISSED: CircleMinus,
  PENDING: CircleDashed
}

const VERDICT_TONE: Record<GitHubReviewState, string> = {
  CHANGES_REQUESTED: 'text-status-warning',
  APPROVED: 'text-status-success',
  COMMENTED: 'text-muted-foreground',
  DISMISSED: 'text-muted-foreground',
  PENDING: 'text-muted-foreground'
}

function getVerdictLabel(state: GitHubReviewState): string {
  switch (state) {
    case 'CHANGES_REQUESTED':
      return translate(
        'auto.components.right.sidebar.checks.panel.review.verdicts.0bf5a253a984',
        'Changes requested'
      )
    case 'APPROVED':
      return translate(
        'auto.components.right.sidebar.checks.panel.review.verdicts.543f808ca47b',
        'Approved'
      )
    case 'COMMENTED':
      return translate(
        'auto.components.right.sidebar.checks.panel.review.verdicts.c040f814f131',
        'Commented'
      )
    case 'DISMISSED':
      return translate(
        'auto.components.right.sidebar.checks.panel.review.verdicts.c9f1d84c1d34',
        'Dismissed'
      )
    case 'PENDING':
      return translate(
        'auto.components.right.sidebar.checks.panel.review.verdicts.3aa4a3edaf3c',
        'Pending'
      )
  }
  // Unreachable for a known state; an unrecognised host value must still read as something.
  return translate(
    'auto.components.right.sidebar.checks.panel.review.verdicts.35c764378830',
    'Reviewed'
  )
}

function ReviewVerdictRow({
  verdict,
  onJumpToComment
}: {
  verdict: PRReviewVerdict
  onJumpToComment?: (commentId: number) => void
}): React.JSX.Element {
  const Icon = VERDICT_ICON[verdict.state]
  const label = getVerdictLabel(verdict.state)
  // Why: a verdict with no body has no comment to land on, so it must not offer a click at all —
  // an affordance that does nothing is worse than no affordance.
  const jump = verdict.hasBody ? onJumpToComment : undefined
  const content = (
    <>
      <Icon className={cn('size-3.5 shrink-0', VERDICT_TONE[verdict.state])} aria-hidden />
      <GitHubUserAvatar
        login={verdict.login}
        avatarUrl={verdict.avatarUrl}
        className="size-4"
        title={verdict.login}
      />
      <span className="min-w-0 truncate text-[12px] font-medium text-foreground">
        {verdict.login}
      </span>
      {verdict.isBot ? (
        <span className="shrink-0 rounded border border-border bg-muted px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {translate('auto.components.right.sidebar.checks.panel.content.2ba0a32bdd', 'bot')}
        </span>
      ) : null}
      {/* The verdict is primary text, not a chip: it reads at the section header's weight. */}
      <span className="ml-auto shrink-0 text-[12px] font-semibold text-foreground">{label}</span>
      {jump ? <ArrowRight className="size-3 shrink-0 text-muted-foreground" aria-hidden /> : null}
    </>
  )

  if (!jump) {
    return <div className="flex min-w-0 items-center gap-2 px-1.5 py-1.5">{content}</div>
  }
  return (
    <button
      type="button"
      className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-accent"
      onClick={() => jump(verdict.id)}
    >
      {content}
    </button>
  )
}

/**
 * The PR's review verdicts, above the `Comments` header.
 *
 * It sits inside the comment section rather than the top of the panel: the checks stay the first
 * thing after the PR header, and "who decided what" belongs with the conversation it summarises.
 */
export function ReviewVerdictsBlock({
  verdicts,
  onJumpToComment
}: {
  verdicts: PRReviewVerdict[]
  onJumpToComment?: (commentId: number) => void
}): React.JSX.Element | null {
  if (verdicts.length === 0) {
    return null
  }
  return (
    <div className="border-b border-border px-3 py-2.5">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {translate(
          'auto.components.right.sidebar.checks.panel.review.verdicts.47c8e272bfb7',
          'Review verdicts'
        )}
      </div>
      <div className="mt-1.5 flex flex-col gap-0.5">
        {verdicts.map((verdict) => (
          <ReviewVerdictRow key={verdict.id} verdict={verdict} onJumpToComment={onJumpToComment} />
        ))}
      </div>
    </div>
  )
}
