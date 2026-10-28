import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/utils'
import {
  filterPRCommentsByAudience,
  getPRCommentAudienceCounts,
  type PRCommentAudienceFilter
} from '../../../../../shared/pr-comment-audience'
import {
  getPRCommentGroupId,
  groupPRComments,
  type PRCommentGroup
} from '../../../../../shared/pr-comment-groups'
import {
  getPRCommentGroupActionState,
  isPRCommentGroupQueueableForAI,
  partitionPRCommentGroupsForTriage,
  sortPRCommentGroupsByRecency
} from '@/lib/pr-comment-action-state'
import {
  scrollElementBottomIntoView,
  scrollElementCenterIntoView
} from '@/lib/element-scroll-reveal'
import {
  filterPRCommentListEntries,
  getPRReviewVerdicts
} from '../../../../../shared/pr-review-verdicts'
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion'
import { getPRCommentPresentationClasses } from '../pr-comment-presentation'
import type { GitHubReactionContent, PRComment } from '../../../../../shared/github/comment-types'
import {
  RightPanelCommentComposer,
  type RightPanelCommentSubmitResult
} from '../right-panel-comment-composer'
import {
  usePRCommentsListSelection,
  type PRCommentsListSelectionClearRequest
} from '../pr-comments-list-selection'
import { usePRBotAuthorOverrides } from '@/lib/pr-bot-author-overrides'
import { translate } from '@/i18n/i18n'
import { PRCommentGroupView } from './comment-group'
import { useNow } from '@/hooks/use-now'

/** How long a jumped-to comment stays marked before the mark clears itself. */
export const PR_COMMENT_REVEAL_HIGHLIGHT_MS = 1500

export type PRCommentsListDisplayMode = 'triage' | 'timeline'
export const PR_COMMENT_LIST_DISPLAY_MODES: PRCommentsListDisplayMode[] = ['triage', 'timeline']
export function getPRCommentsListDisplayModeLabel(mode: PRCommentsListDisplayMode): string {
  return mode === 'triage'
    ? translate('auto.components.right.sidebar.checks.panel.content.8a621a2c4f', 'Grouped')
    : translate('auto.components.right.sidebar.checks.panel.content.b13f85d75c', 'Timeline')
}

export type PRCommentsListProps = {
  comments: PRComment[]
  /** Set when the last read failed; replaces the empty-list copy. */
  commentsError?: string | null
  commentsLoading: boolean
  reviewKind?: 'PR' | 'MR'
  commentsDisabled?: boolean
  commentsDisabledReason?: string
  selectionContextKey?: string
  selectionClearRequest?: PRCommentsListSelectionClearRequest | null
  resolveCommentsWithAIDisabled?: boolean
  resolveCommentsWithAIDisabledReason?: string
  onAddComment?: (body: string) => Promise<RightPanelCommentSubmitResult>
  onResolveSelectedCommentsWithAI?: (groups: PRCommentGroup[]) => void
  onReply?: (comment: PRComment, body: string) => Promise<RightPanelCommentSubmitResult>
  onResolve?: (threadId: string, resolve: boolean) => boolean | Promise<boolean>
  onEditComment?: (comment: PRComment, body: string) => Promise<boolean>
  onDeleteComment?: (comment: PRComment) => void | Promise<void>
  /** Whether review threads are drawn inline in code; drives the Comments header toggle. */
  commentsInlineEnabled?: boolean
  onToggleCommentsInline?: () => void
  /** True when the head rule suppresses inline comments, so the header explains the absence. */
  commentsInlineBlocked?: boolean
  commentsInlineHeadMismatch?: { worktreeHeadOid: string; commentsHeadSha: string } | null
  /** Whether this review context reports verdicts. GitHub only for now: the GitLab client has no
   *  approval state mapped onto the comments payload. */
  reviewVerdictsEnabled?: boolean
  /** Opens a review comment in the code. Absent when there is nowhere to place it. */
  onOpenCommentInCode?: (comment: PRComment) => void
  onSetReaction?: (
    comment: PRComment,
    content: GitHubReactionContent,
    reacted: boolean
  ) => Promise<boolean>
  onOpenLocation?: (path: string, line: number) => void
}

export function useCommentsListState({
  comments,
  commentsDisabled,
  commentsDisabledReason,
  selectionContextKey,
  selectionClearRequest,
  onAddComment,
  onReply,
  onResolve,
  onEditComment,
  onDeleteComment,
  onOpenCommentInCode,
  onSetReaction,
  onResolveSelectedCommentsWithAI,
  onOpenLocation
}: PRCommentsListProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const presentation = React.useMemo(() => getPRCommentPresentationClasses(), [])
  // Why: a review submission with no body is a verdict, not a comment — it must not be counted,
  // grouped, queued for the agent, or rendered as an empty card.
  const listComments = React.useMemo(() => filterPRCommentListEntries(comments), [comments])
  const now = useNow(60_000, listComments.length > 0)
  const prefersReducedMotion = usePrefersReducedMotion()
  const [commentFilter, setCommentFilter] = useState<PRCommentAudienceFilter>('all')
  const [displayMode, setDisplayMode] = useState<PRCommentsListDisplayMode>('triage')
  const [replyingCommentId, setReplyingCommentId] = useState<number | null>(null)
  const [isAddingComment, setIsAddingComment] = useState(false)
  const [resolvedSectionOpen, setResolvedSectionOpen] = useState(false)
  const [highlightedCommentId, setHighlightedCommentId] = useState<number | null>(null)
  const [pendingRevealId, setPendingRevealId] = useState<number | null>(null)
  const addCommentSurfaceRef = useRef<HTMLDivElement>(null)
  const shouldScrollAddCommentRef = useRef(false)
  const botAuthorOverrides = usePRBotAuthorOverrides()
  const verdicts = React.useMemo(
    () => getPRReviewVerdicts(comments, botAuthorOverrides),
    [botAuthorOverrides, comments]
  )
  const commentCounts = React.useMemo(
    () => getPRCommentAudienceCounts(listComments, botAuthorOverrides),
    [botAuthorOverrides, listComments]
  )
  const {
    isSelectingForAI,
    selectedGroupIds,
    selectableGroups,
    selectableGroupsById,
    selectedGroups,
    addGroupToSelection,
    clearSelection,
    toggleGroupSelection
  } = usePRCommentsListSelection(listComments, selectionContextKey, selectionClearRequest)
  const visibleComments = React.useMemo(
    () => filterPRCommentsByAudience(listComments, commentFilter, botAuthorOverrides),
    [botAuthorOverrides, commentFilter, listComments]
  )
  const groups = React.useMemo(() => groupPRComments(visibleComments), [visibleComments])
  const triageGroups = React.useMemo(
    () => partitionPRCommentGroupsForTriage(sortPRCommentGroupsByRecency(groups, 'newest-first')),
    [groups]
  )
  const timelineGroups = React.useMemo(() => sortPRCommentGroupsByRecency(groups), [groups])
  const canShowResolveWithAI = Boolean(
    onResolveSelectedCommentsWithAI && selectableGroups.length > 0
  )
  const selectedCommentQueueCount = selectedGroups.length

  const revealComment = useCallback((commentId: number) => {
    setPendingRevealId(commentId)
  }, [])

  // Why a layout effect: this one reads the DOM it just committed and scrolls it, so running it
  // after paint would show the reader a frame at the old position.
  useLayoutEffect(() => {
    const targetId = pendingRevealId
    if (targetId === null) {
      return
    }
    // Why: the audience filter can hide the target, and silently doing nothing is the dead click
    // this jump exists to avoid — clicking a verdict is an explicit request to see that comment.
    if (commentFilter !== 'all' && !visibleComments.some((comment) => comment.id === targetId)) {
      setCommentFilter('all')
      return
    }
    const element = listRef.current?.querySelector<HTMLElement>(
      `[data-pr-comment-id="${targetId}"]`
    )
    if (!element) {
      // Why: in triage the target can sit inside the collapsed Resolved section, where it has no
      // layout to scroll to until the section opens.
      if (displayMode === 'triage' && !resolvedSectionOpen && triageGroups.resolved.length > 0) {
        setResolvedSectionOpen(true)
        return
      }
      setPendingRevealId(null)
      return
    }
    setPendingRevealId(null)
    scrollElementCenterIntoView(element)
    setHighlightedCommentId(targetId)
  }, [
    pendingRevealId,
    commentFilter,
    visibleComments,
    displayMode,
    resolvedSectionOpen,
    triageGroups
  ])

  useEffect(() => {
    if (highlightedCommentId === null) {
      return
    }
    // Why: reduced motion gets a static mark instead of a timed fade, cleared by the reader's next
    // interaction in the comment area rather than by a clock.
    if (prefersReducedMotion) {
      const container = listRef.current
      if (!container) {
        return
      }
      const clearHighlight = (): void => setHighlightedCommentId(null)
      const events = ['pointerdown', 'wheel', 'keydown'] as const
      events.forEach((event) => container.addEventListener(event, clearHighlight, { once: true }))
      return () => events.forEach((event) => container.removeEventListener(event, clearHighlight))
    }
    const timer = window.setTimeout(
      () => setHighlightedCommentId(null),
      PR_COMMENT_REVEAL_HIGHLIGHT_MS
    )
    return () => window.clearTimeout(timer)
  }, [highlightedCommentId, prefersReducedMotion])

  useEffect(() => {
    if (!isAddingComment || !shouldScrollAddCommentRef.current) {
      return
    }
    shouldScrollAddCommentRef.current = false
    let secondFrame: number | null = null
    const scrollComposerIntoView = (): void => {
      const surface = addCommentSurfaceRef.current
      if (surface) {
        scrollElementBottomIntoView(surface)
      }
    }
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(scrollComposerIntoView)
    })
    // Wait for separate expand/focus layout passes so scrolling uses the composer's final height.
    const settledTimer = window.setTimeout(scrollComposerIntoView, 120)
    return () => {
      window.cancelAnimationFrame(firstFrame)
      if (secondFrame !== null) {
        window.cancelAnimationFrame(secondFrame)
      }
      window.clearTimeout(settledTimer)
    }
  }, [isAddingComment])

  const startAddComment = useCallback(() => {
    shouldScrollAddCommentRef.current = true
    setIsAddingComment(true)
  }, [])

  const cancelAddComment = useCallback(() => {
    shouldScrollAddCommentRef.current = false
    setIsAddingComment(false)
  }, [])

  const renderSelectionControl = (group: PRCommentGroup): React.ReactNode => {
    if (!isSelectingForAI || !selectableGroupsById.has(getPRCommentGroupId(group))) {
      return null
    }
    const groupId = getPRCommentGroupId(group)
    const checked = selectedGroupIds.has(groupId)
    return (
      <Checkbox
        aria-label={translate(
          'auto.components.right.sidebar.checks.panel.content.5dc3af25c0',
          'Select comment'
        )}
        checked={checked}
        onCheckedChange={(value) => toggleGroupSelection(groupId, value === true)}
        className="shrink-0"
      />
    )
  }

  const renderCommentGroup = (group: PRCommentGroup): React.JSX.Element => {
    const groupId = getPRCommentGroupId(group)
    const actionState = getPRCommentGroupActionState(group)
    const isQueued = selectedGroupIds.has(groupId)
    const canQueue =
      canShowResolveWithAI &&
      !isQueued &&
      isPRCommentGroupQueueableForAI(group) &&
      selectableGroupsById.has(groupId) &&
      !isSelectingForAI
    return (
      <PRCommentGroupView
        key={groupId}
        group={group}
        botAuthorOverrides={botAuthorOverrides}
        replyingCommentId={replyingCommentId}
        selectionControl={renderSelectionControl(group)}
        actionState={actionState}
        isQueued={isQueued}
        now={now}
        replyDisabled={commentsDisabled}
        replyDisabledReason={commentsDisabledReason}
        presentation={presentation}
        highlightedCommentId={highlightedCommentId}
        onResolve={onResolve}
        onStartReply={setReplyingCommentId}
        onCancelReply={(commentId) =>
          setReplyingCommentId((current) => (current === commentId ? null : current))
        }
        onReply={onReply}
        onEditComment={onEditComment}
        onDeleteComment={onDeleteComment}
        onOpenCommentInCode={onOpenCommentInCode}
        onSetReaction={onSetReaction}
        onQueueForAgent={canQueue ? () => addGroupToSelection(groupId) : undefined}
        onOpenLocation={onOpenLocation}
      />
    )
  }
  const renderAddCommentComposer = (empty: boolean): React.JSX.Element => (
    <div
      ref={addCommentSurfaceRef}
      className={cn(empty ? 'px-3 py-2' : 'border-t border-border px-3 py-2')}
    >
      <RightPanelCommentComposer
        placeholder={
          empty
            ? translate(
                'auto.components.right.sidebar.checks.panel.content.ea9fd5ed6a',
                'Start conversation...'
              )
            : translate(
                'auto.components.right.sidebar.checks.panel.content.3fff651d32',
                'Add a PR comment'
              )
        }
        submitLabel="Send"
        autoFocus
        disabled={commentsDisabled}
        disabledReason={commentsDisabledReason}
        onCancel={cancelAddComment}
        onSubmit={
          onAddComment ??
          (async () => ({
            ok: false,
            error: translate(
              'auto.components.right.sidebar.checks.panel.content.b37ebdc51c',
              'Commenting unavailable.'
            )
          }))
        }
      />
    </div>
  )

  return {
    presentation,
    listRef,
    listComments,
    verdicts,
    revealComment,
    highlightedCommentId,
    resolvedSectionOpen,
    setResolvedSectionOpen,
    commentFilter,
    setCommentFilter,
    displayMode,
    setDisplayMode,
    replyingCommentId,
    setReplyingCommentId,
    isAddingComment,
    botAuthorOverrides,
    commentCounts,
    isSelectingForAI,
    selectableGroups,
    selectedGroups,
    selectedCommentQueueCount,
    clearSelection,
    visibleComments,
    triageGroups,
    timelineGroups,
    canShowResolveWithAI,
    startAddComment,
    renderCommentGroup,
    renderAddCommentComposer,
    now
  }
}
