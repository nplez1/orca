import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { jiraGetIssue, jiraUpdateIssue } from '@/runtime/runtime-jira-client'
import type { RuntimeJiraSettings } from '@/runtime/runtime-jira-target'
import type { JiraIssue, JiraMutationResult } from '../../../shared/jira/jira-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { JiraWriteTimeoutError } from '@/runtime/jira-write-deadline'
import { enqueueJiraIssueMutation, JiraMutationFailure } from './jira-issue-mutation-queue'
import {
  editedJiraIssueFields,
  type EditableJiraIssueField
} from './jira-issue-workspace-hydration'
import type { JiraIssueSideDataState } from './jira-issue-workspace-side-data'

/** Runs one Jira issue field mutation through the mutation queue: optimistic
 *  patch, sprint move, and the toast on failure. Kept separate from the detail
 *  hook to stay within the file line cap. */
export function useJiraIssueWorkspaceMutation({
  displayed,
  requestKey,
  pendingField,
  mutationContextKey,
  providerSettings,
  siteId,
  sourceContext,
  sideData,
  scopeGenerationRef,
  editedFieldsRef,
  setPendingField,
  onSprintChange
}: {
  displayed: JiraIssue | null
  requestKey: string | null
  pendingField: string | null
  mutationContextKey: string
  providerSettings: RuntimeJiraSettings
  siteId: string | undefined
  sourceContext: TaskSourceContext | null | undefined
  sideData: JiraIssueSideDataState
  scopeGenerationRef: MutableRefObject<number>
  editedFieldsRef: MutableRefObject<Set<EditableJiraIssueField>>
  setPendingField: Dispatch<SetStateAction<string | null>>
  /** Sprint membership is invisible to every other list this issue appears in, so a
   *  committed move has to be announced rather than inferred from an issue field. */
  onSprintChange?: () => void
}): (
  field: string,
  updates: Parameters<typeof jiraUpdateIssue>[2],
  optimistic?: Partial<JiraIssue>,
  options?: { reportsInline?: boolean }
) => Promise<JiraMutationResult> {
  const patchJiraIssue = useAppStore((s) => s.patchJiraIssue)
  const {
    selectSprint,
    reloadSprintAssignment,
    restoreSprintAssignment,
    reloadEditFields,
    sprintAssignment
  } = sideData

  return useCallback(
    async (
      field: string,
      updates: Parameters<typeof jiraUpdateIssue>[2],
      optimistic?: Partial<JiraIssue>,
      options?: { reportsInline?: boolean }
    ): Promise<JiraMutationResult> => {
      if (!displayed || !requestKey || pendingField) {
        return {
          ok: false,
          error: translate(
            'auto.components.JiraIssueWorkspace.anotherUpdatePending',
            'Another Jira update is still in progress.'
          )
        }
      }
      const previous = displayed
      const sprintChanged = updates.sprintId !== undefined
      const previousSprintAssignment = sprintAssignment
      const scopeGeneration = scopeGenerationRef.current
      setPendingField(field)
      for (const editable of optimistic ? editedJiraIssueFields(optimistic) : []) {
        editedFieldsRef.current.add(editable)
      }
      try {
        await enqueueJiraIssueMutation({
          scope: requestKey,
          previous,
          optimistic: optimistic ?? {},
          commentsChanged: Boolean(updates.transitionComment?.trim()),
          update: async () => {
            if (sprintChanged) {
              selectSprint(updates.sprintId ?? null)
            }
            return jiraUpdateIssue(providerSettings, displayed.key, updates, siteId)
          },
          refresh: () => jiraGetIssue(providerSettings, displayed.key, displayed.siteId),
          patchIssue: (patch) =>
            patchJiraIssue(displayed.key, patch, {
              sourceContext,
              siteId: displayed.siteId,
              contextKey: mutationContextKey
            })
        })
        if (sprintChanged) {
          // Why before the re-read: the move is committed by the time this thunk resolves,
          // and the board's reload must not wait on a round trip that only feeds the picker.
          onSprintChange?.()
          await reloadSprintAssignment()
        }
        if (updates.customFields) {
          // Why: the "Edit fields" form seeds itself from the same editmeta read, so
          // a value written here has to be re-read or the two disagree about the field.
          await reloadEditFields()
        }
        return { ok: true }
      } catch (error) {
        if (sprintChanged) {
          // Why the local restore before the re-read: the fault that failed the move
          // usually fails that read too, and the picker must not keep showing a sprint
          // the issue never reached.
          restoreSprintAssignment(previousSprintAssignment)
          await reloadSprintAssignment()
        }
        // Why the timeout first: its message is the shared English constant, and the
        // user needs the "check the value" wording rather than a raw transport string.
        const message =
          error instanceof JiraWriteTimeoutError
            ? translate('jira.issue.writeTimedOut', error.message)
            : extractIpcErrorMessage(
                error,
                translate(
                  'auto.components.JiraIssueWorkspace.ea21952aa3',
                  'Failed to update Jira issue.'
                )
              )
        // Why a flag rather than the field name: more than one surface mutates a
        // transition — the sheet's control reports the error inline, but the pane's
        // status row does not — so only the caller with an inline display opts out.
        if (!options?.reportsInline) {
          toast.error(message)
        }
        // Why carried through: a transition's refusal names the fields it refused,
        // and a surface that shows them inline has nothing to show without this.
        return {
          ok: false,
          error: message,
          ...(error instanceof JiraMutationFailure && error.fieldErrors
            ? { fieldErrors: error.fieldErrors }
            : {}),
          ...(error instanceof JiraMutationFailure && error.errorMessages
            ? { errorMessages: error.errorMessages }
            : {})
        }
      } finally {
        if (scopeGeneration === scopeGenerationRef.current) {
          setPendingField(null)
        }
      }
    },
    [
      displayed,
      editedFieldsRef,
      mutationContextKey,
      onSprintChange,
      patchJiraIssue,
      pendingField,
      providerSettings,
      reloadEditFields,
      reloadSprintAssignment,
      requestKey,
      restoreSprintAssignment,
      scopeGenerationRef,
      selectSprint,
      setPendingField,
      siteId,
      sourceContext,
      sprintAssignment
    ]
  )
}
