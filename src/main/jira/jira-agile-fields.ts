import { createHash } from 'node:crypto'
import { apiBasePath, jiraRequest, type JiraClientForSite } from './authenticated-request'
import { mapCreateField, type JiraAgileFieldIds } from './jira-issue-mapping'
import { isJiraUserField } from '../../shared/jira-field-rendering'
import { asRecord, asString, type JiraRecord } from './jira-record-pages'
import { acquire, release } from './request-queue'
import { settleJiraSummaryRead, withJiraDeadline } from './jira-read-failure'

// The one cached `/field` read per site, answering the agile planning fields and the
// user-picker fields that name an issue's roles (Dev, QE). Two readers, because an issue
// read wants a fast guess while the board's role filter cannot answer without it.

const SPRINT_FIELD_TYPE = 'com.pyxis.greenhopper.jira:gh-sprint'
const STORY_POINTS_TYPE = 'com.pyxis.greenhopper.jira:jsw-story-points'
const NUMBER_FIELD_TYPE = 'com.atlassian.jira.plugin.system.customfieldtypes:float'
const CUSTOM_FIELD_PREFIX = 'customfield_'
const FAILED_DISCOVERY_RETRY_MS = 60_000
const FIELD_CATALOG_TTL_MS = 10 * 60_000
/** JSM's own person lists are not roles: a request participant is copied in rather than
 *  holding a role. Site-defined person pickers are unaffected, and a JSM approver is an
 *  ordinary multi-user picker here — approving is a role, so it stays. */
const NON_ROLE_PERSON_FIELD_PREFIX = 'com.atlassian.servicedesk:'
/** Optional detail: an issue read gives up this fast rather than delay the issue. */
const OPTIONAL_DISCOVERY_DEADLINE_MS = 500
/** Why longer: the board cannot answer "Me" without the catalog, where an issue read is
 *  only decorating itself. */
const BOARD_DISCOVERY_DEADLINE_MS = 4_000

/** What one site's field catalog yields: its agile planning fields, and the
 *  user-picker fields that name an issue's roles besides its assignee. */
export type JiraFieldSelection = {
  agile: JiraAgileFieldIds
  /** Ids of the site's user-picker custom fields (Dev, QE, …), in catalog order. */
  roleFields: string[]
}

/** Ids of the site's user pickers (Dev, QE, …). Only custom fields: Jira's system user
 *  fields are the assignee, the reporter and the creator, and reporting is not a role. */
export function pickJiraFieldSelection(fields: readonly JiraRecord[]): JiraFieldSelection {
  const roleFields: string[] = []
  for (const field of fields) {
    const id = asString(field.id)
    if (!id || !id.startsWith(CUSTOM_FIELD_PREFIX) || roleFields.includes(id)) {
      continue
    }
    // The edit form's own rule for "this is a person picker", so single- and multi-user
    // fields both count and a text field that happens to hold a name does not.
    const mapped = mapCreateField(field, id)
    if (!mapped || !isJiraUserField(mapped)) {
      continue
    }
    if ((mapped.schema?.custom ?? '').startsWith(NON_ROLE_PERSON_FIELD_PREFIX)) {
      continue
    }
    roleFields.push(id)
  }
  return { agile: pickAgileFieldIds(fields), roleFields }
}

export function pickAgileFieldIds(fields: readonly JiraRecord[]): JiraAgileFieldIds {
  const ids: JiraAgileFieldIds = {}
  for (const field of fields) {
    const custom = asString(asRecord(field.schema).custom)
    const id = asString(field.id)
    if (!id) {
      continue
    }
    if (!ids.sprint && custom === SPRINT_FIELD_TYPE) {
      ids.sprint = id
    }
    if (
      custom === STORY_POINTS_TYPE ||
      (custom === NUMBER_FIELD_TYPE && /story points?/i.test(asString(field.name)))
    ) {
      ids.storyPoints ??= []
      if (!ids.storyPoints.includes(id)) {
        ids.storyPoints.push(id)
      }
    }
  }
  return ids
}

function clientCacheKey(entry: JiraClientForSite): string {
  const credential = createHash('sha256').update(entry.authorization).digest('hex')
  return JSON.stringify([
    entry.site.id,
    entry.site.siteUrl,
    entry.site.authType,
    entry.site.accountId,
    credential
  ])
}

type JiraFieldSelectionReader = (
  entry: JiraClientForSite,
  signal?: AbortSignal
) => Promise<JiraFieldSelection>

/** One cached `/field` read per site and credential, with one caller's patience. Each
 *  patience gets its own cache: a caller that gave up early must not hand its empty
 *  answer to a caller that would have waited. */
function createJiraFieldSelectionReader(deadlineMs: number): JiraFieldSelectionReader {
  const cache = new Map<string, Promise<JiraFieldSelection>>()
  const discoveryExpiresAt = new Map<string, number>()

  return function readJiraFieldSelection(
    entry: JiraClientForSite,
    signal?: AbortSignal
  ): Promise<JiraFieldSelection> {
    if (signal?.aborted) {
      return Promise.reject(new Error('Jira field discovery aborted'))
    }
    const key = clientCacheKey(entry)
    const retryAt = discoveryExpiresAt.get(key)
    if (retryAt !== undefined && retryAt <= Date.now()) {
      cache.delete(key)
      discoveryExpiresAt.delete(key)
    }
    let pending = cache.get(key)
    if (!pending) {
      // Discovery owns a queue slot; no search may hold one while awaiting it.
      pending = withJiraDeadline(undefined, deadlineMs, async (requestSignal) => {
        await acquire(requestSignal)
        try {
          const fields = await settleJiraSummaryRead(
            jiraRequest<JiraRecord[]>(entry, `${apiBasePath(entry.site)}/field`, {
              signal: requestSignal
            }),
            requestSignal
          )
          return pickJiraFieldSelection(Array.isArray(fields) ? fields : [])
        } finally {
          release()
        }
      })
        .then((fields) => {
          if (cache.get(key) === pending) {
            discoveryExpiresAt.set(key, Date.now() + FIELD_CATALOG_TTL_MS)
          }
          return fields
        })
        .catch((error) => {
          console.warn('[jira] field discovery failed:', error)
          if (cache.get(key) === pending) {
            discoveryExpiresAt.set(key, Date.now() + FAILED_DISCOVERY_RETRY_MS)
          }
          return { agile: {}, roleFields: [] }
        })
      if (cache.size >= 32) {
        const oldest = cache.keys().next().value
        if (oldest) {
          cache.delete(oldest)
          discoveryExpiresAt.delete(oldest)
        }
      }
      cache.set(key, pending)
    }
    // A cancelled caller cannot cancel discovery another search is sharing.
    return signal ? settleJiraSummaryRead(pending, signal) : pending
  }
}

/** For callers that treat the catalog as optional detail. */
const getOptionalJiraFieldSelection = createJiraFieldSelectionReader(OPTIONAL_DISCOVERY_DEADLINE_MS)

/** For the board, whose "Me" filter cannot be answered without the role fields. */
export const getBoardJiraFieldSelection = createJiraFieldSelectionReader(
  BOARD_DISCOVERY_DEADLINE_MS
)

/** The agile half of the catalog. Returns the same object the selection holds, so
 *  concurrent callers share one instance rather than one per caller. */
export async function getAgileFieldIds(
  entry: JiraClientForSite,
  signal?: AbortSignal
): Promise<JiraAgileFieldIds> {
  return (await getOptionalJiraFieldSelection(entry, signal)).agile
}

export function agileFieldIdList(ids: JiraAgileFieldIds): string[] {
  return [...(ids.sprint ? [ids.sprint] : []), ...(ids.storyPoints ?? [])]
}
