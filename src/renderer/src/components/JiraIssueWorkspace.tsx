import React, { useMemo } from 'react'
import * as VisuallyHidden from 'radix-ui/visually-hidden'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { useAppStore } from '@/store'
import type { JiraIssue } from '../../../shared/jira-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import {
  findJiraIssueWorkspaceAttachmentInIndex,
  type JiraIssueWorkspaceAttachmentIndex
} from '@/lib/jira-issue-workspace-attachment'
import { getWorktreeAttachmentLabel } from '@/lib/worktree-attachment-label'
import { translate } from '@/i18n/i18n'
import { JiraIssueMetadataBar, JiraIssueWorkspaceHeader } from './jira-issue-workspace-chrome'
import { JiraIssueCommentComposer, JiraIssueWorkspaceContent } from './jira-issue-workspace-content'
import { getJiraIssueWorkspaceActions } from './jira-issue-workspace-actions'
import { useJiraIssueWorkspaceDetail } from './jira-issue-workspace-detail-state'

type JiraIssueWorkspaceProps = {
  issue: JiraIssue | null
  /** Workspaces already attached to Jira issues, so the primary action can show the
   *  one belonging to this issue instead of offering to start a duplicate. */
  issueWorkspaceAttachmentIndex: JiraIssueWorkspaceAttachmentIndex
  onOpenOrStartWorkspace: (issue: JiraIssue) => void
  onClose: () => void
  sourceContext?: TaskSourceContext | null
  refreshSignal?: number
}

export default function JiraIssueWorkspace({
  issue,
  issueWorkspaceAttachmentIndex,
  onOpenOrStartWorkspace,
  onClose,
  sourceContext,
  refreshSignal = 0
}: JiraIssueWorkspaceProps): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const providerSettings = sourceContext ?? settings
  const detail = useJiraIssueWorkspaceDetail({
    issue,
    providerSettings,
    sourceContext,
    refreshSignal
  })
  const { displayed } = detail
  // Why derived from `displayed` and not the selected issue: the buttons below send
  // `displayed`, and the detail hook keeps the previous issue for a render after the
  // selection changes — so anything else could label one issue and open another's.
  const attachedWorkspace = displayed
    ? findJiraIssueWorkspaceAttachmentInIndex(issueWorkspaceAttachmentIndex, displayed)
    : null
  const attachedWorkspaceLabel = attachedWorkspace
    ? getWorktreeAttachmentLabel(attachedWorkspace)
    : null
  const actionItems = useMemo(
    () => (displayed ? getJiraIssueWorkspaceActions(displayed) : []),
    [displayed]
  )

  return (
    <Sheet open={issue !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-[min(92vw,780px)] p-0 sm:max-w-[780px]"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <VisuallyHidden.Root asChild>
          <SheetTitle>
            {displayed?.title ??
              translate('auto.components.JiraIssueWorkspace.ef21405c6d', 'Jira issue')}
          </SheetTitle>
        </VisuallyHidden.Root>
        <VisuallyHidden.Root asChild>
          <SheetDescription>
            {translate(
              'auto.components.JiraIssueWorkspace.857bd2f88f',
              'Preview, edit, and start work from the selected issue.'
            )}
          </SheetDescription>
        </VisuallyHidden.Root>

        {displayed ? (
          <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
            <JiraIssueWorkspaceHeader
              attachedWorkspaceLabel={attachedWorkspaceLabel}
              displayed={displayed}
              issueLoading={detail.issueLoading}
              onOpenOrStartWorkspace={onOpenOrStartWorkspace}
              onClose={onClose}
            />

            <JiraIssueMetadataBar
              displayed={displayed}
              pendingField={detail.pendingField}
              transitions={detail.transitions}
              priorities={detail.priorities}
              users={detail.users}
              mutateIssue={detail.mutateIssue}
            />

            <JiraIssueWorkspaceContent
              displayed={displayed}
              titleDraft={detail.titleDraft}
              setTitleDraft={detail.setTitleDraft}
              labelsDraft={detail.labelsDraft}
              setLabelsDraft={detail.setLabelsDraft}
              handleSaveTitle={detail.handleSaveTitle}
              handleSaveLabels={detail.handleSaveLabels}
              pendingField={detail.pendingField}
              comments={detail.comments}
              commentsError={detail.commentsError}
              commentsLoading={detail.commentsLoading}
              retryComments={detail.retryComments}
              attachedWorkspaceLabel={attachedWorkspaceLabel}
              onOpenOrStartWorkspace={onOpenOrStartWorkspace}
              actionItems={actionItems}
            />

            <JiraIssueCommentComposer
              commentDraft={detail.commentDraft}
              setCommentDraft={detail.setCommentDraft}
              commentSubmitting={detail.commentSubmitting}
              canSubmitComment={detail.canSubmitComment}
              handleSubmitComment={() => void detail.handleSubmitComment()}
            />
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
