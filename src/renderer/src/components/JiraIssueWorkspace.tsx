import React, { useCallback, useMemo } from 'react'
import * as VisuallyHidden from 'radix-ui/visually-hidden'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { useAppStore } from '@/store'
import type { JiraIssue } from '../../../shared/jira/jira-types'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../shared/task-source-context'
import {
  findJiraIssueWorkspaceAttachmentInIndex,
  type JiraIssueWorkspaceAttachmentIndex
} from '@/lib/jira-issue-workspace-attachment'
import { getWorktreeAttachmentLabel } from '@/lib/worktree-attachment-label'
import { translate } from '@/i18n/i18n'
import { JiraIssueMetadataBar, JiraIssueWorkspaceHeader } from './jira-issue-workspace-chrome'
import { getJiraSelfUser } from './jira-self-user'
import { JiraIssueCommentComposer, JiraIssueWorkspaceContent } from './jira-issue-workspace-content'
import { getJiraIssueWorkspaceActions } from './jira-issue-workspace-actions'
import type { RuntimeJiraSettings } from '@/runtime/runtime-jira-target'
import { getJiraRuntimeTarget } from '@/runtime/runtime-jira-target'
import { getEnvironmentRuntimeContextKey } from '@/lib/provider-runtime-context'
import { runtimeTargetEnvironmentId } from '@/runtime/runtime-client-target'
import { useJiraIssueWorkspaceDetail } from './jira-issue-workspace-detail-state'

const EMPTY_ATTACHMENT_INDEX: JiraIssueWorkspaceAttachmentIndex = new Map()

type JiraIssueWorkspaceProps = {
  issue: JiraIssue | null
  /** Workspaces already attached to Jira issues, so the primary action can show the
   *  one belonging to this issue instead of offering to start a duplicate. */
  issueWorkspaceAttachmentIndex?: JiraIssueWorkspaceAttachmentIndex
  onClose: () => void
  /** The issue's own source; every read, write and cache patch routes by its owner. Required,
   *  because a Jira issue always belongs to a source and a row-less open would otherwise read
   *  whichever server is focused. */
  sourceContext: TaskSourceContext
  /** Board the issue's sprint is changed on. Sprint membership is board state, so
   *  without one there is nothing to move the issue into; the caller omits it
   *  where the surface has no board. */
  sprintBoard?: { boardId: string; siteId: string } | null
  refreshSignal?: number
  /** Reports a committed sprint move to the surface hosting this sheet, so the lists
   *  the issue appears in reload — sprint membership is board state, not an issue field. */
  onSprintChange?: () => void
  /** Opens the issue's attached workspace, or starts one; the second argument is the
   *  detail's own source, which Cmd-J can point at another host than the task source. */
  onUse: (issue: JiraIssue, source?: TaskSourceContext | null) => void
}

export default function JiraIssueWorkspace({
  issue,
  issueWorkspaceAttachmentIndex = EMPTY_ATTACHMENT_INDEX,
  onUse,
  onClose,
  sourceContext,
  sprintBoard = null,
  refreshSignal = 0,
  onSprintChange
}: JiraIssueWorkspaceProps): React.JSX.Element {
  // Why the bound source: the label resolves `sourceContext` (the detail source, which
  // Cmd-J can set to another host than the task source), so the click must hand the
  // handler the same source or the two can name different workspaces for one link.
  const handleOpenOrStart = useCallback(
    (target: JiraIssue) => onUse(target, sourceContext),
    [onUse, sourceContext]
  )
  const jiraStatus = useAppStore((s) => s.jiraStatus)
  const providerSettings: RuntimeJiraSettings = sourceContext
  // Why derived rather than resolved twice: the image target and the RPC source must name the
  // same host, or the detail renders one server's issue beside another server's images. Why the
  // memo: the resolver allocates a target per call, and the detail hook refetches on its identity.
  const owner = useMemo(() => getJiraRuntimeTarget(sourceContext), [sourceContext])
  const runtimeContextKey = getEnvironmentRuntimeContextKey(runtimeTargetEnvironmentId(owner))
  const detail = useJiraIssueWorkspaceDetail({
    issue,
    providerSettings,
    sourceContext,
    sprintBoard,
    refreshSignal,
    onSprintChange
  })
  const { displayed } = detail
  // Why derived from `displayed` and not the selected issue: the buttons below send
  // `displayed`, and the detail hook keeps the previous issue for a render after the
  // selection changes — so anything else could label one issue and open another's.
  const attachedWorkspace = displayed
    ? findJiraIssueWorkspaceAttachmentInIndex(
        issueWorkspaceAttachmentIndex,
        displayed,
        sourceContext
      )
    : null
  const attachedWorkspaceLabel = attachedWorkspace
    ? getWorktreeAttachmentLabel(attachedWorkspace)
    : null
  const actionItems = useMemo(
    () => (displayed ? getJiraIssueWorkspaceActions(displayed) : []),
    [displayed]
  )
  const siteId = displayed?.siteId ?? undefined
  // Why the owner (not just the source) in the key: a row-less source remounts the
  // metadata bar when the execution host changes, so a half-typed transition form
  // cannot be submitted against the wrong host.
  const metadataKey = JSON.stringify([
    sourceContext ? getTaskSourceCacheScope(sourceContext) : owner,
    siteId,
    displayed?.key
  ])
  // Why the issue's own site: the viewer identity is per site, and the picker pins
  // "me" for the issue being edited, not for the host's currently selected site.
  const selfUser = useMemo(
    () => (displayed ? getJiraSelfUser(jiraStatus, displayed.siteId ?? null) : null),
    [displayed, jiraStatus]
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
              onOpenOrStartWorkspace={handleOpenOrStart}
              onClose={onClose}
            />

            <JiraIssueMetadataBar
              key={metadataKey}
              displayed={displayed}
              pendingField={detail.pendingField}
              transitions={detail.transitions}
              transitionsLoading={detail.transitionsLoading}
              transitionsError={detail.transitionsError}
              reloadTransitions={() => void detail.reloadTransitions()}
              priorities={detail.priorities}
              prioritiesError={detail.prioritiesError}
              users={detail.users}
              editFields={detail.editFields}
              editFieldsLoading={detail.editFieldsLoading}
              editFieldsError={detail.editFieldsError}
              reloadEditFields={() => void detail.reloadEditFields()}
              selfUser={selfUser}
              providerSettings={providerSettings}
              sourceContext={sourceContext}
              owner={owner}
              runtimeContextKey={runtimeContextKey}
              sprintAssignment={detail.sprintAssignment}
              sprintAssignmentError={detail.sprintAssignmentError}
              mutateIssue={detail.mutateIssue}
              submitIssueFields={detail.submitIssueFields}
            />

            <JiraIssueWorkspaceContent
              displayed={displayed}
              imageTarget={owner}
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
              onOpenOrStartWorkspace={handleOpenOrStart}
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
