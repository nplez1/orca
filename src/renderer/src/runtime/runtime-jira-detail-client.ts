import { JIRA_IMAGE_CAPABILITY } from '../../../shared/jira/jira-attachment-image'
import { migrateLegacyJiraImages } from './runtime-jira-image-cache'
import type {
  JiraComment,
  JiraCommentBodyFormat,
  JiraEditableField,
  JiraIssue,
  JiraIssueUpdate,
  JiraMutationResult,
  JiraPriority,
  JiraTransition
} from '../../../shared/jira/jira-types'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import {
  assertRuntimeEnvironmentCapability,
  callRuntimeRpc,
  runtimeEnvironmentSupportsCapability
} from './runtime-rpc-client'
import { JIRA_TRANSITION_FIELDS_RUNTIME_CAPABILITY } from '../../../shared/jira/jira-detail-capabilities'
import { RuntimeRpcCallError } from './runtime-rpc-result'
import { readRuntimeJiraPayload } from './runtime-jira-payload-stream'
import { withJiraWriteDeadline } from './jira-write-deadline'

export type JiraCommentResult = { ok: true; id: string } | { ok: false; error: string }

async function readRemoteJiraPayload<TResult>(
  target: { kind: 'environment'; environmentId: string },
  streamMethod: string,
  fallbackMethod: string,
  args: unknown
): Promise<TResult> {
  try {
    return await readRuntimeJiraPayload<TResult>(target, streamMethod, args)
  } catch (error) {
    if (!(error instanceof RuntimeRpcCallError) || error.code !== 'method_not_found') {
      throw error
    }
    // Older runtimes lack image streaming but still serve text through the original one-shot method.
    return callRuntimeRpc<TResult>(target, fallbackMethod, args, { timeoutMs: 30_000 })
  }
}

export async function jiraGetIssueForTarget(
  target: RuntimeClientTarget,
  key: string,
  siteId?: string | null
): Promise<JiraIssue | null> {
  const references =
    target.kind === 'local' ||
    (await runtimeEnvironmentSupportsCapability(target.environmentId, JIRA_IMAGE_CAPABILITY))
  const args = {
    key,
    siteId: siteId ?? undefined,
    ...(references ? { mediaFormat: 'reference' as const } : {})
  }
  const issue =
    target.kind === 'environment'
      ? references
        ? await callRuntimeRpc<JiraIssue | null>(target, 'jira.getIssue', args, {
            timeoutMs: 30_000
          })
        : await readRemoteJiraPayload<JiraIssue | null>(
            target,
            'jira.getIssueStream',
            'jira.getIssue',
            args
          )
      : await window.api.jira.getIssue(args)
  return issue
    ? { ...issue, description: migrateLegacyJiraImages(issue.description ?? '', target) }
    : null
}

export async function jiraUpdateIssueForTarget(
  target: RuntimeClientTarget,
  key: string,
  updates: JiraIssueUpdate,
  siteId?: string | null
): Promise<JiraMutationResult> {
  if (
    target.kind === 'environment' &&
    (updates.transitionFields || updates.transitionComment !== undefined)
  ) {
    await assertRuntimeEnvironmentCapability(
      target.environmentId,
      JIRA_TRANSITION_FIELDS_RUNTIME_CAPABILITY,
      'Update the remote Orca server to submit required transition fields, or complete the transition in Jira.'
    )
  }
  const args = { key, updates, siteId: siteId ?? undefined }
  return withJiraWriteDeadline((signal) =>
    target.kind === 'environment'
      ? callRuntimeRpc<JiraMutationResult>(target, 'jira.updateIssue', args, {
          timeoutMs: 30_000,
          signal
        })
      : window.api.jira.updateIssue(args)
  )
}

export async function jiraAddIssueCommentForTarget(
  target: RuntimeClientTarget,
  key: string,
  body: string,
  siteId?: string | null,
  /** Omitted by a caller that already sent plain text; the host stores it verbatim. */
  bodyFormat?: JiraCommentBodyFormat
): Promise<JiraCommentResult> {
  const args = { key, body, siteId: siteId ?? undefined, bodyFormat }
  return target.kind === 'environment'
    ? callRuntimeRpc<JiraCommentResult>(target, 'jira.addIssueComment', args, {
        timeoutMs: 30_000
      })
    : window.api.jira.addIssueComment(args)
}

/**
 * Fields the user can edit on an existing issue, with the values it holds. A remote
 * runtime that predates the method cannot answer; editing is then simply unavailable,
 * so the miss degrades to an empty list instead of failing the detail view.
 */
export async function jiraListEditFieldsForTarget(
  target: RuntimeClientTarget,
  key: string,
  siteId?: string | null
): Promise<JiraEditableField[]> {
  const args = { key, siteId: siteId ?? undefined }
  if (target.kind !== 'environment') {
    return window.api.jira.listEditFields(args)
  }
  try {
    return await callRuntimeRpc<JiraEditableField[]>(target, 'jira.listEditFields', args, {
      timeoutMs: 30_000
    })
  } catch (error) {
    if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
      return []
    }
    throw error
  }
}

export async function jiraIssueCommentsForTarget(
  target: RuntimeClientTarget,
  key: string,
  siteId?: string | null
): Promise<JiraComment[]> {
  const references =
    target.kind === 'local' ||
    (await runtimeEnvironmentSupportsCapability(target.environmentId, JIRA_IMAGE_CAPABILITY))
  const args = {
    key,
    siteId: siteId ?? undefined,
    ...(references ? { mediaFormat: 'reference' as const } : {})
  }
  const comments =
    target.kind === 'environment'
      ? references
        ? await callRuntimeRpc<JiraComment[]>(target, 'jira.issueComments', args, {
            timeoutMs: 30_000
          })
        : await readRemoteJiraPayload<JiraComment[]>(
            target,
            'jira.issueCommentsStream',
            'jira.issueComments',
            args
          )
      : await window.api.jira.issueComments(args)
  return comments.map((comment) => ({
    ...comment,
    body: migrateLegacyJiraImages(comment.body, target)
  }))
}

export async function jiraListPrioritiesForTarget(
  target: RuntimeClientTarget,
  siteId?: string | null
): Promise<JiraPriority[]> {
  return target.kind === 'environment'
    ? callRuntimeRpc<JiraPriority[]>(
        target,
        'jira.listPriorities',
        siteId ? { siteId } : undefined,
        { timeoutMs: 30_000 }
      )
    : window.api.jira.listPriorities(siteId ? { siteId } : undefined)
}

export async function jiraListTransitionsForTarget(
  target: RuntimeClientTarget,
  key: string,
  siteId?: string | null
): Promise<JiraTransition[]> {
  const args = { key, siteId: siteId ?? undefined, strict: true }
  return target.kind === 'environment'
    ? callRuntimeRpc<JiraTransition[]>(target, 'jira.listTransitions', args, { timeoutMs: 30_000 })
    : window.api.jira.listTransitions(args)
}
