import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { useMountedRef } from '@/hooks/useMountedRef'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { Worktree } from '../../../../shared/worktree/types'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import type { WorktreeMetaUpdateOptions } from '@/store/slices/worktree-helpers'
import { parseIssueLinkInput } from '../../../../shared/issue-link-input'
import {
  buildWorktreeMetaUpdates,
  isIssueFieldDirty,
  keepsLiveJiraWorkItem,
  type ResolvedJiraIssueLink,
  type WorktreeMetaDraft,
  type WorktreeMetaLiveLinks,
  type WorktreeMetaSavedPayload,
  type WorktreeMetaSnapshot,
  type WorktreeReviewProvider
} from './worktree-meta-updates'
import { getLinkedWorkItemReplacementBlock } from './worktree-issue-displacement'
import { useResolveWorktreeMetaJiraLink } from './use-worktree-meta-jira-link'
import { toWorktreeMetaLiveLinks } from './use-worktree-meta-workspace'

/** Saving the workspace details dialog.
 *
 *  Pulled out of the dialog because a Jira link has to be resolved — a network
 *  read — before anything is written, which makes the save span an await and
 *  brings its own rules: one save at a time, a request generation so a cancelled
 *  dialog cannot be closed by an old completion, and a fresh re-read of the link
 *  state on the other side of the read. */
export function useWorktreeMetaSave(input: {
  worktreeId: string
  isOpen: boolean
  executionHostId?: ExecutionHostId
  suppressHostedReviewRefresh: boolean
  /** The two fields the Jira read needs: its host, and the context it routes through. */
  worktree: Pick<Worktree, 'hostId' | 'linkedTaskSourceContext'> | undefined
  canSave: boolean
  draft: WorktreeMetaDraft
  snapshot: WorktreeMetaSnapshot
  liveLinks: WorktreeMetaLiveLinks
  reviewProvider: WorktreeReviewProvider
  updateWorktreeMeta: (
    worktreeId: string,
    updates: Partial<WorktreeMeta>,
    options?: WorktreeMetaUpdateOptions
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  closeModal: () => void
  afterSave: ((payload: WorktreeMetaSavedPayload) => void | Promise<void>) | null
}): {
  saving: boolean
  saveError: string | null
  /** A fresh dialog session: retires any in-flight save and clears the last error. */
  beginSession: () => void
  save: () => Promise<void>
} {
  const {
    worktreeId,
    isOpen,
    executionHostId,
    suppressHostedReviewRefresh,
    worktree,
    canSave,
    draft,
    snapshot,
    liveLinks,
    reviewProvider,
    updateWorktreeMeta,
    closeModal,
    afterSave
  } = input
  const resolveJiraIssueLink = useResolveWorktreeMetaJiraLink({ worktree })
  const mountedRef = useMountedRef()
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  // Why: a save that awaits a Jira lookup can otherwise be re-entered from the
  // Enter handlers (the Save button is disabled while it runs, they are not), and
  // its completion can outlive the dialog it belongs to.
  const savingRef = useRef(false)
  const saveRequestRef = useRef(0)

  // Why state only: this runs while the dialog renders its open seed, and a ref
  // written during render can be lost when React discards that render.
  const beginSession = useCallback(() => setSaveError(null), [])

  // Why an effect, not the open path: a save that outlives its dialog session must
  // not close or apply to the next one, and closing is the moment that becomes true.
  useEffect(() => {
    if (!isOpen) {
      saveRequestRef.current += 1
    }
  }, [isOpen])

  /** The Jira link to write, or the reason to stop. Nothing to resolve for another
   *  provider, an untouched field, or a value that only respells the stored issue —
   *  the last of which is why a disconnected Jira cannot block a comment edit. */
  const prepareJiraLink = useCallback(async (): Promise<
    { ok: true; link: ResolvedJiraIssueLink | null } | { ok: false; error: string }
  > => {
    if (
      draft.issueProvider !== 'jira' ||
      !isIssueFieldDirty(draft, snapshot) ||
      keepsLiveJiraWorkItem(draft, liveLinks)
    ) {
      return { ok: true, link: null }
    }
    const replacementBlock = getLinkedWorkItemReplacementBlock(liveLinks)
    if (replacementBlock) {
      return { ok: false, error: replacementBlock }
    }
    const parsed = parseIssueLinkInput(draft.issueInput.trim(), 'jira')
    if (!parsed || parsed.provider !== 'jira') {
      return { ok: true, link: null }
    }
    const resolution = await resolveJiraIssueLink(parsed)
    return resolution.ok
      ? { ok: true, link: resolution.link }
      : { ok: false, error: resolution.error }
  }, [draft, liveLinks, resolveJiraIssueLink, snapshot])

  const save = useCallback(async (): Promise<void> => {
    if (!canSave || savingRef.current) {
      return
    }
    // Why: an issue link has to be resolved before anything is written, so the
    // save spans an await. Everything after it re-proves it is still the current
    // request for this dialog before it persists or closes.
    const requestId = ++saveRequestRef.current
    const isCurrentRequest = (): boolean =>
      mountedRef.current && saveRequestRef.current === requestId
    savingRef.current = true
    setSaving(true)
    // Why: a stale failure from the previous attempt must not sit under the
    // spinner for the whole in-flight save.
    setSaveError(null)
    try {
      const prepared = await prepareJiraLink()
      if (!isCurrentRequest()) {
        return
      }
      if (!prepared.ok) {
        setSaveError(prepared.error)
        return
      }
      const jiraLink = prepared.link

      // Why: the lookup is a network read, so the link state it was decided
      // against may have moved. Re-read it rather than letting a link added during
      // the await outlive a save that just promised to displace it.
      const freshWorktree = useAppStore
        .getState()
        .getKnownWorktreeById(worktreeId, executionHostId ?? undefined)
      const freshLive = freshWorktree ? toWorktreeMetaLiveLinks(freshWorktree) : liveLinks
      // Why: a work item the field does not own can appear during the await. The
      // builder would then omit the Jira write silently, so the save would report a
      // success that quietly dropped the link the user asked for.
      if (jiraLink) {
        const lateReplacementBlock = getLinkedWorkItemReplacementBlock(freshLive)
        if (lateReplacementBlock) {
          setSaveError(lateReplacementBlock)
          return
        }
      }
      const updates = buildWorktreeMetaUpdates(draft, snapshot, freshLive, reviewProvider, jiraLink)

      const result =
        executionHostId || suppressHostedReviewRefresh
          ? await updateWorktreeMeta(worktreeId, updates, {
              ...(executionHostId ? { executionHostId } : {}),
              ...(suppressHostedReviewRefresh ? { suppressHostedReviewRefresh: true } : {})
            })
          : await updateWorktreeMeta(worktreeId, updates)
      // Why: a failed save refetches and reverts the optimistic write. Closing
      // here would report success for an edit that silently undid itself, and
      // would discard the name, comment and PR changes in the same payload.
      if (!result.ok) {
        if (mountedRef.current) {
          setSaveError(result.error)
        }
        return
      }
      // Why: the write itself spans an await, and the dialog can be cancelled and
      // reopened during it. Only the request that is still current may report a
      // success and close.
      if (!isCurrentRequest()) {
        return
      }
      closeModal()
      // Why: follow-up refreshes should not turn a successful metadata save
      // into a failed dialog.
      try {
        void Promise.resolve(afterSave?.({ worktreeId, updates })).catch(console.error)
      } catch (error) {
        console.error(error)
      }
    } finally {
      savingRef.current = false
      if (mountedRef.current) {
        setSaving(false)
      }
    }
  }, [
    afterSave,
    canSave,
    closeModal,
    draft,
    executionHostId,
    liveLinks,
    mountedRef,
    prepareJiraLink,
    reviewProvider,
    snapshot,
    suppressHostedReviewRefresh,
    updateWorktreeMeta,
    worktreeId
  ])

  return { saving, saveError, beginSession, save }
}
