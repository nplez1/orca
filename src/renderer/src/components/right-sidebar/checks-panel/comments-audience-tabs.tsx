import React from 'react'
import { cn } from '@/lib/utils'
import { getPrCommentAudienceFilters } from '@/lib/pr-comment-audience-labels'
import type { PRCommentAudienceFilter } from '../../../../../shared/pr-comment-audience'
import type { PRCommentPresentationClasses } from '../pr-comment-presentation'

/** The All / Humans / Bots switch above the comment list, with each tab's count. */
export function CommentsAudienceTabs({
  presentation,
  filter,
  counts,
  onSelect
}: {
  presentation: PRCommentPresentationClasses
  filter: PRCommentAudienceFilter
  counts: Record<PRCommentAudienceFilter, number>
  onSelect: (filter: PRCommentAudienceFilter) => void
}): React.JSX.Element {
  return (
    <div className={presentation.audienceTabs}>
      {getPrCommentAudienceFilters().map((candidate) => {
        const isActive = filter === candidate.value
        return (
          <button
            key={candidate.value}
            type="button"
            className={cn(presentation.audienceTab, isActive && presentation.audienceTabActive)}
            aria-pressed={isActive}
            onClick={() => onSelect(candidate.value)}
          >
            <span>{candidate.label}</span>
            <span className="tabular-nums">{counts[candidate.value]}</span>
          </button>
        )
      })}
    </div>
  )
}
