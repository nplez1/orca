import { useEffect, useMemo, useRef, useState, type ComponentProps } from 'react'
import type { JiraBoardSelection, JiraIssue } from '../../../../../shared/jira/jira-types'
import { accountBackedDetailSource } from '@/lib/account-backed-detail-source'
import type JiraIssueWorkspace from '@/components/JiraIssueWorkspace'
import type { TaskPageComposerActionsModel } from '../../use-task-page-composer-actions'

type JiraIssueWorkspaceBoardProps = Pick<
  ComponentProps<typeof JiraIssueWorkspace>,
  | 'issueWorkspaceAttachmentIndex'
  | 'onUse'
  | 'sourceContext'
  | 'sprintBoard'
  | 'refreshSignal'
  | 'onSprintChange'
>

export type JiraBoardMode = {
  /** The configured agile board, only while the board view is the one showing. */
  activeBoard: JiraBoardSelection | null
  /** The configured agile board whichever view is showing, so the list can offer a way back. */
  configuredBoard: JiraBoardSelection | null
  /**
   * The runtime serving Jira cannot run the board view. A capability miss, not a preference:
   * it lives in memory, so an upgraded runtime brings the board back without a settings edit.
   */
  runtimeBoardUnavailable: boolean
  reportRuntimeBoardUnavailable: () => void
  retryBoard: () => void
  showBoard: () => void
  showIssueList: () => void
  boardRefreshSignal: number
  notifyIssueMoved: (issue: JiraIssue) => void
  /** The detail sheet's props, shared by both views so a move or sprint change reaches it. */
  workspaceProps: JiraIssueWorkspaceBoardProps
}

/** The configured-board view mode the fork layers over upstream's Jira task content. */
export function useJiraBoardMode(model: TaskPageComposerActionsModel): JiraBoardMode {
  const {
    selectedJiraIssue,
    jiraDetailSourceContext,
    jiraTaskSourceContext,
    accountBackedTaskSourceHostId,
    setJiraRefreshNonce,
    jiraBoardViewMode,
    setJiraBoardViewMode,
    jiraIssueAttachmentIndex,
    handleOpenOrUseJiraItem
  } = model
  const defaultJiraBoard = model.settings?.defaultJiraBoard ?? null
  const boardOwnerHostId = jiraTaskSourceContext?.hostId ?? accountBackedTaskSourceHostId
  const [jiraDetailRefreshSignal, setJiraDetailRefreshSignal] = useState(0)
  const [jiraBoardRefreshSignal, setJiraBoardRefreshSignal] = useState(0)
  // Why the host id, not a boolean: a capability miss belongs to the runtime that answered it,
  // so another host (an upgraded one) is available again without the user retrying.
  const [unavailableBoardHostId, setUnavailableBoardHostId] = useState<string | null>(null)
  const runtimeBoardUnavailable =
    unavailableBoardHostId !== null && unavailableBoardHostId === boardOwnerHostId
  const boardSelectionRef = useRef<string | null>(null)
  const jiraBoardSelectionKey = defaultJiraBoard
    ? `${defaultJiraBoard.siteId}:${defaultJiraBoard.boardId}`
    : null
  const notifyJiraIssueMoved = (issue: JiraIssue): void => {
    if (
      selectedJiraIssue?.key === issue.key &&
      (!selectedJiraIssue.siteId || !issue.siteId || selectedJiraIssue.siteId === issue.siteId)
    ) {
      setJiraDetailRefreshSignal((signal) => signal + 1)
    }
  }
  // Why both: a sprint move changes which list an item is in, and the surface holding that
  // list differs by view — the board's own pages in board mode, the searched list otherwise.
  const notifyJiraSprintChange = (): void => {
    setJiraRefreshNonce((value) => value + 1)
    setJiraBoardRefreshSignal((value) => value + 1)
  }

  useEffect(() => {
    // Why: only a genuine board change forces the board view; the first resolved
    // selection must not clobber a restored issue-list preference.
    const previousSelectionKey = boardSelectionRef.current
    boardSelectionRef.current = jiraBoardSelectionKey
    if (previousSelectionKey !== null && previousSelectionKey !== jiraBoardSelectionKey) {
      setJiraBoardViewMode('board')
    }
  }, [jiraBoardSelectionKey, setJiraBoardViewMode])

  // Why memoised: the workspace refetches on its source's identity, and a fresh object per render
  // would re-run every detail read.
  const jiraDetailOwnerSource = useMemo(
    () =>
      jiraDetailSourceContext ??
      jiraTaskSourceContext ??
      accountBackedDetailSource('jira', accountBackedTaskSourceHostId),
    [accountBackedTaskSourceHostId, jiraDetailSourceContext, jiraTaskSourceContext]
  )

  return {
    // Why: a runtime that cannot serve the board must not read as a preference for the list,
    // so the fallback stays out of `jiraBoardViewMode` and out of localStorage.
    activeBoard:
      defaultJiraBoard && jiraBoardViewMode === 'board' && !runtimeBoardUnavailable
        ? defaultJiraBoard
        : null,
    configuredBoard: defaultJiraBoard,
    runtimeBoardUnavailable,
    reportRuntimeBoardUnavailable: () => setUnavailableBoardHostId(boardOwnerHostId),
    retryBoard: () => setUnavailableBoardHostId(null),
    showBoard: () => setJiraBoardViewMode('board'),
    showIssueList: () => setJiraBoardViewMode('list'),
    boardRefreshSignal: jiraBoardRefreshSignal,
    notifyIssueMoved: notifyJiraIssueMoved,
    workspaceProps: {
      issueWorkspaceAttachmentIndex: jiraIssueAttachmentIndex,
      onUse: handleOpenOrUseJiraItem,
      sourceContext: jiraDetailOwnerSource,
      sprintBoard: defaultJiraBoard,
      refreshSignal: jiraDetailRefreshSignal,
      onSprintChange: notifyJiraSprintChange
    }
  }
}
