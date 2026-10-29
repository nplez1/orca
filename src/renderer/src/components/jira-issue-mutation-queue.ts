import type {
  JiraFieldErrors,
  JiraIssue,
  JiraMutationResult
} from '../../../shared/jira/jira-types'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { getJiraReadIdentity } from '@/store/slices/jira-read-coordination'
import { JiraWriteTimeoutError } from '@/runtime/jira-write-deadline'
import {
  editedJiraIssueFields,
  jiraIssueFieldsLanded,
  jiraIssueRollbackPatch,
  mergeJiraIssueHydration,
  type EditableJiraIssueField
} from './jira-issue-workspace-hydration'

type IssuePatchListener = (
  patch: Partial<JiraIssue>,
  rollback: boolean,
  statusSettled: boolean,
  commentsChanged: boolean
) => void
type IssueWrite = {
  confirmed: JiraIssue
  pending: { patch: Partial<JiraIssue> }[]
  tail: Promise<void> | null
}

const writes = new Map<string, IssueWrite>()
const listeners = new Map<string, Set<IssuePatchListener>>()

/**
 * A rejected write carrying Jira's own reason and its field-level sentences, so
 * a surface can name the control the site refused instead of showing one
 * flattened message.
 */
export class JiraMutationFailure extends Error {
  constructor(
    message: string,
    readonly fieldErrors?: JiraFieldErrors,
    /** Jira's workflow messages, which a field-level display would otherwise hide. */
    readonly errorMessages?: string[]
  ) {
    super(message)
    this.name = 'JiraMutationFailure'
  }
}

export function jiraIssueRequestScope(
  issue: JiraIssue | null,
  sourceContext: TaskSourceContext | null | undefined,
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
): string | null {
  if (!issue) {
    return null
  }
  const scope = getJiraReadIdentity(settings, sourceContext)
  return JSON.stringify([
    scope.cachePrefix ?? scope.contextKey,
    issue.siteId ?? 'selected',
    issue.key
  ])
}

export function subscribeJiraIssueMutation(
  scope: string,
  listener: IssuePatchListener,
  replay: (patch: Partial<JiraIssue>) => void
): () => void {
  const subscribers = listeners.get(scope) ?? new Set<IssuePatchListener>()
  subscribers.add(listener)
  listeners.set(scope, subscribers)
  const pendingPatch: Partial<JiraIssue> = {}
  for (const mutation of writes.get(scope)?.pending ?? []) {
    Object.assign(pendingPatch, mutation.patch)
  }
  if (Object.keys(pendingPatch).length > 0) {
    replay(pendingPatch)
  }
  return () => {
    subscribers.delete(listener)
    if (subscribers.size === 0) {
      listeners.delete(scope)
    }
  }
}

export function enqueueJiraIssueMutation({
  scope,
  previous,
  optimistic,
  commentsChanged = false,
  update,
  refresh,
  patchIssue
}: {
  scope: string
  previous: JiraIssue
  optimistic: Partial<JiraIssue>
  commentsChanged?: boolean
  update: () => Promise<JiraMutationResult>
  refresh: () => Promise<JiraIssue | null>
  patchIssue: (patch: Partial<JiraIssue>) => void
}): Promise<void> {
  const write: IssueWrite = writes.get(scope) ?? { confirmed: previous, pending: [], tail: null }
  const predecessor = write.tail
  const protectedFields = new Set(
    write.pending.flatMap((queued) => editedJiraIssueFields(queued.patch))
  )
  write.confirmed = mergeJiraIssueHydration(previous, write.confirmed, protectedFields)
  const mutation = { patch: optimistic }
  write.pending.push(mutation)
  writes.set(scope, write)

  const publish = (
    patch: Partial<JiraIssue>,
    rollback: boolean,
    statusSettled = false,
    changedComments = false
  ): void => {
    if (Object.keys(patch).length === 0) {
      return
    }
    patchIssue(patch)
    for (const listener of listeners.get(scope) ?? []) {
      listener(patch, rollback, statusSettled, changedComments)
    }
  }
  publish(optimistic, false)

  // Serialize this issue across reopen/remount, preserving later optimistic fields.
  const request = (async (): Promise<void> => {
    await predecessor?.catch(() => undefined)
    let saved = false
    let refreshed = false
    // Why deferred rather than thrown here: the publish below has to run first, so a
    // rollback reaches the screen before the toast that explains it.
    let failure: Error | null = null
    // Fields a later queued edit already owns must survive the read that replaces this one.
    const newerFields = (): Set<EditableJiraIssueField> =>
      new Set(
        write.pending
          .filter((queued) => queued !== mutation)
          .flatMap((queued) => editedJiraIssueFields(queued.patch))
          .filter((field) => !(field in optimistic))
      )
    const revalidate = async (): Promise<JiraIssue | null> => {
      const latest = await refresh().catch(() => null)
      if (latest) {
        write.confirmed = mergeJiraIssueHydration(latest, write.confirmed, newerFields())
      }
      return latest
    }
    try {
      const result = await update()
      if (!result.ok) {
        if (result.timedOut === true) {
          throw new JiraWriteTimeoutError()
        }
        throw new JiraMutationFailure(result.error, result.fieldErrors, result.errorMessages)
      }
      saved = true
      write.confirmed = { ...write.confirmed, ...optimistic }
      refreshed = (await revalidate()) !== null
    } catch (error) {
      if (error instanceof JiraWriteTimeoutError) {
        // Why the read decides: the host may have committed a write nobody answered,
        // and a blind rollback would show the old value for a saved one.
        const latest = await revalidate()
        refreshed = latest !== null
        saved = latest !== null && jiraIssueFieldsLanded(latest, optimistic)
        if (!saved) {
          failure = error
        }
      } else {
        failure = error instanceof Error ? error : new Error(String(error))
      }
    } finally {
      write.pending.splice(write.pending.indexOf(mutation), 1)
      let patch: Partial<JiraIssue> = saved
        ? refreshed
          ? write.confirmed
          : optimistic
        : jiraIssueRollbackPatch(write.confirmed, optimistic)
      for (const newer of write.pending) {
        if (saved) {
          patch = { ...patch, ...newer.patch }
        } else {
          for (const field of editedJiraIssueFields(newer.patch)) {
            delete patch[field]
          }
        }
      }
      publish(
        patch,
        !saved,
        'status' in optimistic && !write.pending.some((queued) => 'status' in queued.patch),
        saved && commentsChanged
      )
    }
    if (failure) {
      throw failure
    }
  })()
  write.tail = request
  const cleanup = (): void => {
    if (writes.get(scope)?.tail === request) {
      writes.delete(scope)
    }
  }
  void request.then(cleanup, cleanup)
  return request
}
