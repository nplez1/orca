import type {
  JiraCommentBodyFormat,
  JiraCreateIssueArgs,
  JiraCreateIssueResult,
  JiraIssueUpdate,
  JiraMutationResult,
  JiraSite
} from '../../shared/jira-types'
import { acquire, release } from './request-queue'
import { apiBasePath, jiraRequest, JiraApiError } from './authenticated-request'
import { clearToken, getClients, isAuthError } from './client'
import { JIRA_AGILE_API } from './jira-agile-api'
import { issueUrl, toBodyText } from './jira-issue-mapping'
import { markdownCommentBody } from './jira-comment-body'
import type { JiraRecord } from './jira-record-pages'

/**
 * Wraps a user id in the reference object the site expects: `{accountId}` on
 * Cloud, `{name}` on Server/DC, which identifies users by username and whose
 * ids `mapUser` stores in the accountId slot.
 */
export function userFieldRef(site: JiraSite, id: string | null): JiraRecord {
  return site.authType === 'server' ? { name: id } : { accountId: id }
}

/**
 * Shapes a user-typed create value (scalar or array) into Jira's user reference
 * objects. Jira rejects a bare string here and reports the field as missing.
 */
function toUserFieldValue(site: JiraSite, value: unknown): unknown {
  if (typeof value === 'string') {
    return userFieldRef(site, value)
  }
  if (Array.isArray(value)) {
    return value.map((member) => (typeof member === 'string' ? userFieldRef(site, member) : member))
  }
  return value
}

/**
 * Writes custom-field values into a Jira field map, shaping the keys named by
 * `userFieldKeys`. `null` clears a field and must reach Jira, so an update keeps
 * it; create cannot set null and skips it.
 */
function applyCustomFieldValues(
  site: JiraSite,
  target: JiraRecord,
  values: Record<string, unknown> | undefined,
  userFieldKeys: readonly string[] | undefined,
  textFieldKeys: readonly string[] | undefined,
  mode: 'create' | 'update'
): void {
  const userKeys = new Set(userFieldKeys ?? [])
  const textKeys = new Set(textFieldKeys ?? [])
  for (const [fieldKey, value] of Object.entries(values ?? {})) {
    if (!fieldKey || value === undefined) {
      continue
    }
    if (userKeys.has(fieldKey)) {
      target[fieldKey] = value === null || value === '' ? null : toUserFieldValue(site, value)
      continue
    }
    if (typeof value === 'string' && value.trim() && textKeys.has(fieldKey)) {
      // Why: REST v2 takes wiki/plain text and v3 takes ADF, and the renderer cannot
      // know the site; converting here also lets Markdown parse instead of arriving
      // as literal paragraphs.
      target[fieldKey] = markdownCommentBody(site, value)
      continue
    }
    if (value !== null && value !== '') {
      target[fieldKey] = value
    } else if (mode === 'update') {
      target[fieldKey] = value
    }
  }
}

/** Jira's own field-level rejections, so the UI can name the offending field. */
function describeUpdateFailure(error: unknown): JiraMutationResult {
  if (error instanceof JiraApiError) {
    return {
      ok: false,
      error: error.message,
      ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
      ...(error.errorMessages ? { errorMessages: error.errorMessages } : {})
    }
  }
  return { ok: false, error: error instanceof Error ? error.message : 'Failed to update issue.' }
}

/** Creates an issue, shaping the customFields keys named by `userFieldKeys`. */
export async function createIssue(args: JiraCreateIssueArgs): Promise<JiraCreateIssueResult> {
  const entry = getClients(args.siteId)[0]
  if (!entry) {
    return { ok: false, error: 'Not connected to Jira.' }
  }
  const title = args.title.trim()
  if (!title) {
    return { ok: false, error: 'Title is required.' }
  }

  await acquire()
  try {
    const fields: JiraRecord = {
      project: { id: args.projectId },
      issuetype: { id: args.issueTypeId },
      summary: title
    }
    if (args.description?.trim()) {
      fields.description = toBodyText(entry.site, args.description.trim())
    }
    applyCustomFieldValues(
      entry.site,
      fields,
      args.customFields,
      args.userFieldKeys,
      args.textFieldKeys,
      'create'
    )
    const created = await jiraRequest<{ id: string; key: string; self: string }>(
      entry,
      `${apiBasePath(entry.site)}/issue`,
      {
        method: 'POST',
        body: JSON.stringify({ fields })
      }
    )
    return { ok: true, id: created.id, key: created.key, url: issueUrl(entry.site, created.key) }
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.site.id)
      throw error
    }
    return { ok: false, error: error instanceof Error ? error.message : 'Failed to create issue.' }
  } finally {
    release()
  }
}

/** Applies field, assignee, transition, and sprint updates to an existing issue. */
export async function updateIssue(
  key: string,
  updates: JiraIssueUpdate,
  siteId?: string | null
): Promise<JiraMutationResult> {
  const entry = getClients(siteId)[0]
  if (!entry) {
    return { ok: false, error: 'Not connected to Jira.' }
  }
  if (updates.labels && updates.labelOperations) {
    return { ok: false, error: 'Pass labels or labelOperations, not both.' }
  }
  await acquire()
  try {
    const fields: JiraRecord = {}
    if (updates.title !== undefined) {
      fields.summary = updates.title
    }
    if (updates.labels !== undefined) {
      fields.labels = updates.labels
    }
    if (updates.priorityId !== undefined) {
      fields.priority = updates.priorityId ? { id: updates.priorityId } : null
    }
    const issueBase = `${apiBasePath(entry.site)}/issue/${encodeURIComponent(key)}`
    applyCustomFieldValues(
      entry.site,
      fields,
      updates.customFields,
      updates.userFieldKeys,
      updates.textFieldKeys,
      'update'
    )
    const labelOperations: ({ add: string } | { remove: string })[] = [
      ...[...new Set(updates.labelOperations?.add ?? [])].map((add) => ({ add })),
      ...[...new Set(updates.labelOperations?.remove ?? [])].map((remove) => ({ remove }))
    ]
    if (Object.keys(fields).length > 0 || labelOperations.length > 0) {
      await jiraRequest(entry, issueBase, {
        method: 'PUT',
        body: JSON.stringify({
          fields,
          ...(labelOperations.length ? { update: { labels: labelOperations } } : {})
        })
      })
    }
    if (updates.assigneeAccountId !== undefined) {
      const assigneeBody = userFieldRef(entry.site, updates.assigneeAccountId)
      await jiraRequest(entry, `${issueBase}/assignee`, {
        method: 'PUT',
        body: JSON.stringify(assigneeBody)
      })
    }
    if (updates.transitionId) {
      const transitionFields: JiraRecord = {}
      applyCustomFieldValues(
        entry.site,
        transitionFields,
        updates.transitionFields,
        updates.transitionUserFieldKeys,
        updates.transitionTextFieldKeys,
        'update'
      )
      const transitionBody: JiraRecord = { transition: { id: updates.transitionId } }
      if (Object.keys(transitionFields).length > 0) {
        transitionBody.fields = transitionFields
      }
      if (updates.transitionComment?.trim()) {
        transitionBody.update = {
          comment: [{ add: { body: toBodyText(entry.site, updates.transitionComment.trim()) } }]
        }
      }
      await jiraRequest(entry, `${issueBase}/transitions`, {
        method: 'POST',
        body: JSON.stringify(transitionBody)
      })
    }
    if (updates.sprintId !== undefined) {
      // Why: sprint membership is board state, not an issue field — the Agile API
      // owns it, and the field-based equivalent needs a per-site custom field id.
      await jiraRequest(
        entry,
        updates.sprintId
          ? `${JIRA_AGILE_API}/sprint/${encodeURIComponent(updates.sprintId)}/issue`
          : `${JIRA_AGILE_API}/backlog/issue`,
        {
          method: 'POST',
          body: JSON.stringify({ issues: [key] })
        }
      )
    }
    return { ok: true }
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.site.id)
      throw error
    }
    return describeUpdateFailure(error)
  } finally {
    release()
  }
}

export async function addIssueComment(
  key: string,
  body: string,
  siteId?: string | null,
  bodyFormat: JiraCommentBodyFormat = 'plain'
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const entry = getClients(siteId)[0]
  if (!entry) {
    return { ok: false, error: 'Not connected to Jira.' }
  }
  await acquire()
  try {
    const comment = await jiraRequest<{ id: string }>(
      entry,
      `${apiBasePath(entry.site)}/issue/${encodeURIComponent(key)}/comment`,
      {
        method: 'POST',
        // Why the branch: only Orca's own composer writes Markdown, and only it
        // may be reinterpreted — a body from the CLI or an already-wiki body must
        // reach Jira exactly as it was typed.
        body: JSON.stringify({
          body:
            bodyFormat === 'markdown'
              ? markdownCommentBody(entry.site, body)
              : toBodyText(entry.site, body)
        })
      }
    )
    return { ok: true, id: comment.id }
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.site.id)
      throw error
    }
    return { ok: false, error: error instanceof Error ? error.message : 'Failed to add comment.' }
  } finally {
    release()
  }
}
