/* eslint-disable max-lines -- Why: upstream-owned and at its budget; the fork s delta rides inside it (+103 code lines), and splitting costs a permanent sync hunk. */
import {
  forgeCredentialTarget,
  forgeOwnerHostIdForWorkspace
} from '@/runtime/source-control/forge/forge-credential-target'
import React, { useCallback } from 'react'
import { ImeInput } from '@/lib/text-input/ime/ime-text-field'
import { Check, LoaderCircle, Pencil, X } from 'lucide-react'
import { DetachedHeadBadge } from '@/components/DetachedHeadBadge'
import HostedReviewActions from '../../hosted-review/provider-actions/HostedReviewActions'
import { GitHubPRStackMap } from '../../hosted-review/provider-actions/GitHubPRStackMap'
import { SourceControlAgentActionDialog } from '../../source-control/ai/SourceControlAgentActionDialog'
import { ChecksPanelUpdatedAtMetadata } from './checks-panel-updated-at-metadata'
import { getChecksPanelRefreshErrorBannerLine } from '../../hosted-review/provider-actions/github-refresh-error-copy'
import { resolveChecksPanelHostedReviewModifierDestination } from '../review-actions/checks-panel-hosted-review-click-routing'
import { clearPendingPRCommentAiAck } from '../comments/pr-comments-ai-launch-ack'
import {
  getBrokenChecks,
  isBrokenCheck
} from '../../../../../../shared/source-control/checks/pr-checks-fix-prompt'
import { PRTriageStrip } from './triage-strip'
import { ConflictingFilesSection, MergeConflictNotice } from './conflict-summary'
import { ChecksList } from './checks-list'
import {
  findWorkspaceReviewAttachment,
  isChecksPaneReviewProvider,
  isWorkspaceReviewProvider,
  workspaceReviewSelectionKey
} from '../../workspace-review-selection'
import { PRCommentsList } from '../comments/comments-list'
import { openAnnotationLocation } from '@/components/editor/check-details/actions/check-annotation-open'
import { useTranslate } from '@/i18n/use-translate'
import type { ChecksPanelActiveContentModel } from './active-content-props'
import { useWorktreePRCommentInline } from '../../../pr-comment-inline/worktree-pr-comment-inline'
import { usePRCommentCodeNavigation } from '../../../pr-comment-inline/pr-comment-code-navigation'
import { isPRCommentsInlineEnabled } from '@/lib/pr-comment-inline-setting'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import type { PRComment } from '../../../../../../shared/github/comment-types'
import { ChecksPanelReviewHeader } from './review-header'

export function ChecksPanelActiveContent({
  model
}: {
  model: ChecksPanelActiveContentModel
}): React.JSX.Element | null {
  const t = useTranslate()
  const {
    activeConnectionId,
    activeConflictReview,
    activeGitLabReview,
    activeReview,
    activeSourceControlLaunchPlatform,
    activeWorktree,
    activeWorktreeId,
    agentComposerState,
    aiActionDisabledReason,
    fixChecksDisabledReason,
    canTargetPRComments,
    checks,
    checksError,
    checksLoading,
    claimedCommentResolutionRef,
    commentResolutionLaunchAcceptedRef,
    comments,
    commentsDisabledReason,
    commentsError,
    commentsLoading,
    commentsSelectionClearRequest,
    conflictDetailsRefreshing,
    detachedHeadDisplay,
    editingTitle,
    getGitLabProjectRef,
    gitLabPipelineCheck,
    handleAddPRComment,
    handleCancelEdit,
    handleDeleteComment,
    handleEditComment,
    handleFixChecksWithAI,
    handleLinkAnotherReview,
    handleLoadCheckDetails,
    handleOpenPR,
    handleOpenStackPR,
    handleRefresh,
    handleReplyToComment,
    handleResolve,
    handleResolveCommentsWithAI,
    handleResolveConflictsWithAI,
    handleSaveTitle,
    handleSetReaction,
    handleStartEdit,
    handleTitleKeyDown,
    handleUnlinkReview,
    isFixingChecksWithAI,
    isRefreshing,
    isResolvingConflictsWithAI,
    manualRefreshError,
    pendingCommentResolutionRef,
    pr,
    prRefreshState,
    refreshHostedReviewAfterMutation,
    repo,
    resolveCommentsWithAIDisabledReason,
    reviewSelection,
    saveLaunchActionDefault,
    setAgentComposerState,
    setChecksPanelContentRef,
    settings,
    showsPickedReview,
    sourceControlAiActionsVisible,
    stateRequestKey,
    titleDraft,
    titleInputRef,
    titleSaving,
    setTitleDraft,
    activeWorktreePath,
    updateSettings
  } = model
  // Why: the toggle and the explanation must describe what the editor actually does, so both read
  // the same derivation the editor uses rather than the panel's own review lookup.
  const prCommentInline = useWorktreePRCommentInline(activeWorktreeId)
  const commentsInlineEnabled = prCommentInline.enabled
  const inlineMismatch =
    prCommentInline.blocker?.kind === 'head-mismatch' ? prCommentInline.blocker : null
  const renderableReviewEntries = reviewSelection.entries.filter((entry) =>
    isChecksPaneReviewProvider(entry.provider)
  )
  const shownReviewKey =
    activeReview && isWorkspaceReviewProvider(activeReview.provider)
      ? workspaceReviewSelectionKey(activeReview.provider, activeReview.number)
      : null
  const reviewSwitcher = {
    entries: renderableReviewEntries,
    selectedKey: renderableReviewEntries.some((entry) => entry.key === shownReviewKey)
      ? shownReviewKey
      : null,
    onSelectReview: reviewSelection.selectReview
  }
  const openCommentInCode = usePRCommentCodeNavigation({
    worktreeId: activeWorktreeId,
    worktreePath: activeWorktreePath,
    reviewBaseRefName: activeReview?.baseRefName ?? null
  })
  const handleToggleCommentsInline = useCallback((): void => {
    void updateSettings({ prCommentsInlineEnabled: !isPRCommentsInlineEnabled(settings) })
  }, [settings, updateSettings])
  const handleOpenCommentInCode = useCallback(
    (comment: PRComment): void => {
      // Why: only an unopenable comment falls back to the provider — an outdated thread still opens
      // its file, just without the scroll.
      if (!openCommentInCode(comment) && comment.url) {
        openAppHttpLink(comment.url)
      }
    },
    [openCommentInCode]
  )
  if (!activeReview) {
    return null
  }
  const reviewShortLabel = activeReview.provider === 'gitlab' ? 'MR' : 'PR'
  const shownReviewRow = findWorkspaceReviewAttachment(activeWorktree, activeReview)
  const canUnlinkReview = showsPickedReview
    ? shownReviewRow !== null
    : activeReview.provider === 'github' || shownReviewRow !== null
  const shouldShowReviewTriageStrip =
    activeConflictReview !== null ||
    (gitLabPipelineCheck !== null && isBrokenCheck(gitLabPipelineCheck)) ||
    getBrokenChecks(checks).length > 0
  const hostedReviewModifierHintDestination = resolveChecksPanelHostedReviewModifierDestination(
    settings,
    Boolean(activeWorktreeId)
  )
  // A classified GitHub failure says more than a manual one, so it wins; one banner either way.
  const refreshError =
    (activeReview.provider === 'github' && prRefreshState?.status === 'error'
      ? getChecksPanelRefreshErrorBannerLine(prRefreshState.errorType, t)
      : null) ?? manualRefreshError
  return (
    <div ref={setChecksPanelContentRef} className="flex-1 overflow-auto scrollbar-sleek">
      {refreshError ? (
        <div
          role="alert"
          className="border-b border-border/50 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {refreshError}
        </div>
      ) : null}
      <div className="px-3 py-3 border-b border-border space-y-2.5">
        <ChecksPanelReviewHeader
          review={activeReview}
          isRefreshing={isRefreshing}
          canUnlinkReview={canUnlinkReview}
          modifierHintDestination={hostedReviewModifierHintDestination}
          onRefresh={() => void handleRefresh()}
          onOpenReview={handleOpenPR}
          onUnlinkReview={handleUnlinkReview}
          onLinkAnotherReview={handleLinkAnotherReview}
          reviewSwitcher={reviewSwitcher}
        />

        {detachedHeadDisplay && <DetachedHeadBadge display={detachedHeadDisplay} side="bottom" />}

        {activeReview.provider === 'github' && pr?.stack ? (
          <GitHubPRStackMap
            stack={pr.stack}
            currentPRNumber={pr.number}
            onOpenPullRequest={handleOpenStackPR}
          />
        ) : null}

        {editingTitle ? (
          <div className="flex items-center gap-1">
            <ImeInput
              ref={titleInputRef}
              className="flex-1 text-[12px] bg-background border border-border rounded px-2 py-1 text-foreground outline-none focus:ring-1 focus:ring-ring"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onKeyDown={handleTitleKeyDown}
              disabled={titleSaving}
            />
            <button
              className="cursor-pointer rounded p-1 text-emerald-500 transition-colors hover:bg-accent hover:text-emerald-400 disabled:cursor-default disabled:opacity-50"
              title={t('auto.components.right.sidebar.ChecksPanel.2ab7fd4b6d', 'Save')}
              onClick={() => void handleSaveTitle()}
              disabled={titleSaving}
            >
              {titleSaving ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <Check className="size-3.5" />
              )}
            </button>
            <button
              className="cursor-pointer rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-50"
              title={t('auto.components.right.sidebar.ChecksPanel.058039787c', 'Cancel')}
              onClick={handleCancelEdit}
              disabled={titleSaving}
            >
              <X className="size-3.5" />
            </button>
          </div>
        ) : (
          <div
            className="group/title flex items-start gap-1.5 cursor-pointer -mx-1 px-1 py-0.5 rounded hover:bg-accent/40 transition-colors"
            onClick={handleStartEdit}
          >
            <span className="text-[12px] text-foreground leading-snug flex-1">
              {activeReview.title}
            </span>
            <Pencil className="size-3 text-muted-foreground/40 can-hover:opacity-0 group-hover/title:opacity-100 transition-opacity shrink-0 mt-0.5" />
          </div>
        )}

        {activeReview.updatedAt && (
          <ChecksPanelUpdatedAtMetadata
            reviewShortLabel={reviewShortLabel}
            updatedAt={activeReview.updatedAt}
          />
        )}
        {activeReview && activeWorktree && repo && (
          <HostedReviewActions
            review={activeReview}
            githubPR={pr}
            repo={repo}
            worktree={activeWorktree}
            onRefreshReview={refreshHostedReviewAfterMutation}
          />
        )}
      </div>

      {shouldShowReviewTriageStrip && sourceControlAiActionsVisible && !showsPickedReview && (
        <PRTriageStrip
          review={activeConflictReview ?? activeReview}
          reviewKind={reviewShortLabel}
          checks={checks}
          pipelineCheck={gitLabPipelineCheck}
          isResolvingConflictsWithAI={isResolvingConflictsWithAI}
          onResolveConflictsWithAI={() => void handleResolveConflictsWithAI()}
          resolveConflictsDisabled={Boolean(aiActionDisabledReason)}
          resolveConflictsDisabledReason={aiActionDisabledReason}
          isFixingChecksWithAI={isFixingChecksWithAI}
          onFixChecksWithAI={() => void handleFixChecksWithAI()}
          fixChecksDisabled={Boolean(fixChecksDisabledReason)}
          fixChecksDisabledReason={fixChecksDisabledReason}
        />
      )}
      {activeConflictReview && (
        <>
          {/* The triage strip owns Resolve; these sections only provide conflict information. */}
          <ConflictingFilesSection pr={activeConflictReview} />
          <MergeConflictNotice
            pr={activeConflictReview}
            isRefreshingConflictDetails={isRefreshing || conflictDetailsRefreshing}
          />
        </>
      )}
      {/* Conflicts can prevent checks running; do not claim no checks are configured before resolving them. */}
      {!(activeConflictReview && checks.length === 0 && !gitLabPipelineCheck && !checksLoading) && (
        <ChecksList
          checks={checks}
          pipelineCheck={gitLabPipelineCheck}
          checksError={manualRefreshError ? null : checksError}
          checksLoading={checksLoading}
          checkDetailsContextKey={stateRequestKey}
          onLoadCheckDetails={handleLoadCheckDetails}
          githubRepository={pr?.prRepo ?? null}
          getGitLabProjectRef={getGitLabProjectRef}
        />
      )}
      <PRCommentsList
        imageUploadAddress={
          pr && model.repo
            ? () => ({
                runtime: forgeCredentialTarget({
                  repoOwnerExecutionHostId: forgeOwnerHostIdForWorkspace(
                    model.repo!,
                    activeWorktree
                  )
                }),
                target: {
                  kind: 'repo',
                  repo: model.repo!.id,
                  source: 'origin',
                  ownerRepo: pr.prRepo ?? undefined
                }
              })
            : undefined
        }
        editImageUploadAddress={
          pr?.prRepo && model.repo
            ? () => ({
                runtime: forgeCredentialTarget({
                  repoOwnerExecutionHostId: forgeOwnerHostIdForWorkspace(
                    model.repo!,
                    activeWorktree
                  )
                }),
                target: { kind: 'slug', ...pr.prRepo!, wakeWslDistro: true }
              })
            : undefined
        }
        comments={comments}
        commentsError={manualRefreshError ? null : commentsError}
        commentsLoading={commentsLoading}
        reviewKind={reviewShortLabel}
        commentsDisabled={!canTargetPRComments}
        commentsDisabledReason={commentsDisabledReason}
        selectionContextKey={stateRequestKey}
        selectionClearRequest={commentsSelectionClearRequest}
        resolveCommentsWithAIDisabled={Boolean(resolveCommentsWithAIDisabledReason)}
        resolveCommentsWithAIDisabledReason={resolveCommentsWithAIDisabledReason}
        onAddComment={pr ? handleAddPRComment : undefined}
        onResolveSelectedCommentsWithAI={
          sourceControlAiActionsVisible ? handleResolveCommentsWithAI : undefined
        }
        onReply={pr ? handleReplyToComment : undefined}
        onResolve={pr || activeGitLabReview ? handleResolve : undefined}
        onEditComment={pr ? handleEditComment : undefined}
        onDeleteComment={pr ? handleDeleteComment : undefined}
        commentsInlineEnabled={commentsInlineEnabled}
        onToggleCommentsInline={activeWorktreeId ? handleToggleCommentsInline : undefined}
        commentsInlineBlocked={inlineMismatch !== null}
        reviewVerdictsEnabled={activeReview?.provider === 'github'}
        commentsInlineHeadMismatch={
          inlineMismatch
            ? {
                worktreeHeadOid: inlineMismatch.worktreeHeadOid,
                commentsHeadSha: inlineMismatch.commentsHeadSha
              }
            : null
        }
        onOpenCommentInCode={activeWorktreePath ? handleOpenCommentInCode : undefined}
        onSetReaction={canTargetPRComments ? handleSetReaction : undefined}
        onOpenLocation={
          activeWorktree
            ? (path, line) =>
                openAnnotationLocation({
                  worktreeId: activeWorktree.id,
                  executionHostId: activeWorktree.hostId,
                  path,
                  line
                })
            : undefined
        }
      />
      <SourceControlAgentActionDialog
        open={sourceControlAiActionsVisible && agentComposerState !== null}
        onOpenChange={(open) => {
          if (!open) {
            setAgentComposerState(null)
            // Keep accepted-launch payloads; other closes must drop them so later actions cannot post stale replies.
            if (!commentResolutionLaunchAcceptedRef.current) {
              pendingCommentResolutionRef.current = null
              claimedCommentResolutionRef.current = null
              clearPendingPRCommentAiAck()
            }
          }
        }}
        actionId={agentComposerState?.actionId ?? 'fixChecks'}
        title={
          agentComposerState?.title ??
          t('auto.components.right.sidebar.ChecksPanel.7fad8509fe', 'Fix With AI')
        }
        description={agentComposerState?.description ?? ''}
        baseCommandInput={agentComposerState?.prompt ?? ''}
        worktreeId={activeWorktreeId}
        groupId={activeWorktreeId}
        connectionId={activeConnectionId}
        repoId={repo?.id ?? null}
        promptDelivery="submit-after-ready"
        launchPlatform={activeSourceControlLaunchPlatform}
        launchSource={agentComposerState?.launchSource ?? 'task_page'}
        onSaveAgentDefault={saveLaunchActionDefault}
        {...agentComposerState?.launchContext}
      />
    </div>
  )
}
