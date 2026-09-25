import { createElement } from 'react'
import { GitMerge } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getReviewStateIcon } from '@/components/github/review-state-presentation'
import {
  getHostedReviewMergeReadiness,
  type HostedReviewMergeMarker
} from '@/components/hosted-review-merge-readiness'
import { PullRequestIcon } from './WorktreeCardHelpers'
import type { WorktreeCardPrDisplay } from './worktree-card-pr-display'

export function getReviewLabel(review: WorktreeCardPrDisplay): 'MR' | 'PR' {
  return review.provider === 'gitlab' ? 'MR' : 'PR'
}

export function getProviderName(review: WorktreeCardPrDisplay): string {
  if (review.provider === 'gitlab') {
    return 'GitLab'
  }
  if (review.provider === 'bitbucket') {
    return 'Bitbucket'
  }
  if (review.provider === 'azure-devops') {
    return 'Azure DevOps'
  }
  if (review.provider === 'gitea') {
    return 'Gitea'
  }
  return 'GitHub'
}

// Why: checks only gate a review that is actually open; draft/closed/merged keep
// their state tone so the glyph agrees with its tooltip. A stateless row (folder
// cards render one while a linked review is loading or its details failed) has no
// state glyph to contradict, so it still flags problems — but never claims success,
// since emerald would assert an open review we have not confirmed.
function getCheckTone(review: WorktreeCardPrDisplay): string | null {
  if (review.state && review.state !== 'open') {
    return null
  }
  if (review.status === 'failure') {
    return 'text-rose-500/85'
  }
  if (review.status === 'pending') {
    return 'text-amber-500/85'
  }
  if (review.state === 'open' && review.status === 'success') {
    return 'text-emerald-500/80'
  }
  return null
}

function getStateTone(state: WorktreeCardPrDisplay['state']): string {
  if (state === 'merged') {
    return 'text-purple-600/70 dark:text-purple-400/70'
  }
  if (state === 'open') {
    return 'text-emerald-500/80'
  }
  if (state === 'closed') {
    return 'text-muted-foreground/60'
  }
  if (state === 'draft') {
    return 'text-muted-foreground/50'
  }
  return 'text-muted-foreground opacity-70'
}

export function ReviewIcon({
  review,
  className,
  variant = 'provider'
}: {
  review: WorktreeCardPrDisplay
  className?: string
  variant?: 'provider' | 'generic'
}): React.JSX.Element {
  const providerIcon =
    variant === 'provider' && review.provider === 'gitlab' ? GitMerge : PullRequestIcon
  const Icon = getReviewStateIcon(review.state) ?? providerIcon
  return createElement(Icon, {
    className: cn(className, getCheckTone(review) ?? getStateTone(review.state))
  })
}

/** The marker's tone names which kind of not-yet, not how bad it is. */
const MERGE_MARKER_TONE: Record<Exclude<HostedReviewMergeMarker, 'none'>, string> = {
  checking: 'bg-muted-foreground/70',
  waiting: 'bg-status-warning',
  blocked: 'bg-destructive'
}

/**
 * The glyph's colour already answers "how did CI go", so mergeability rides alongside it as a
 * corner dot rather than recolouring the glyph — otherwise a PR with green checks and a pending
 * approval would turn amber and read as failing CI.
 *
 * A dot therefore means "the provider named something that stops this merge" — amber for a
 * requirement still outstanding, rose for a hard blocker — or, muted, "the provider has not
 * decided yet". Its absence means the provider positively reported an open merge box, so a
 * dotless green glyph never asserts a mergeability nobody confirmed.
 *
 * The dot is not raised for checks-only blockers: the glyph colour already carries those, and a
 * marker that fires for CI would mean nothing more than the colour it sits on.
 *
 * Why the dot ring: it cuts the marker out of the glyph's strokes so a 5px dot stays legible at
 * 13px. Why no legend: the reason travels in the tooltip and the screen-reader label
 * (`getReviewStatusLabel`), so the marker never has to carry a meaning on colour alone.
 */
export function ReviewIconWithMergeMarker({
  review,
  className,
  variant = 'generic'
}: {
  review: WorktreeCardPrDisplay
  className?: string
  variant?: 'provider' | 'generic'
}): React.JSX.Element {
  const { marker } = getHostedReviewMergeReadiness(review)

  if (marker === 'none') {
    return <ReviewIcon review={review} className={className} variant={variant} />
  }

  return (
    <span className="relative inline-flex">
      <ReviewIcon review={review} className={className} variant={variant} />
      <span
        aria-hidden="true"
        data-review-merge-marker={marker}
        className={cn(
          'absolute -right-px -bottom-px size-[5px] rounded-full ring-2 ring-sidebar',
          MERGE_MARKER_TONE[marker]
        )}
      />
    </span>
  )
}
