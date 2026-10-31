import { basename } from 'node:path'
import { getDefaultPersistedState } from '../../shared/constants'
import { getWorkspaceAttachmentKey } from '../../shared/workspace-attachment-normalization'
import { worktreeWorkspaceKey } from '../../shared/workspace-scope'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import { migrateWorktreeIdentity } from '../persistence/tracking-repos/worktree-identity-migration'
import { WORKSPACE_SESSION_WORKTREE_REFERENCE_KIND } from '../persistence/restoring-sessions/session-worktree-ownership'

const CREATE_FIELDS = [
  'createdAt',
  'orcaCreatedAt',
  'orcaCreationSource',
  'orcaCreationWorkspaceLayout',
  'createdWithAgent',
  'creatorProvenance',
  'baseRef',
  'branchNameWasGenerated'
] as const satisfies readonly (keyof WorktreeMeta)[]

const LINK_FIELDS = [
  'linkedWorkItem',
  'linkedTaskSourceContext',
  'linkedIssue',
  'linkedPR',
  'linkedGitLabIssue',
  'linkedGitLabMR'
] as const satisfies readonly (keyof WorktreeMeta)[]

const LINEAR_FIELDS = [
  'linkedLinearIssue',
  'linkedLinearIssueWorkspaceId',
  'linkedLinearIssueOrganizationUrlKey'
] as const satisfies readonly (keyof WorktreeMeta)[]

const ROW_STATE_FIELDS = [
  'workspaceStatus',
  'sortOrder',
  'manualOrder',
  'isUnread',
  'isPinned',
  'isArchived',
  'lastActivityAt',
  'pendingFirstAgentMessageRename',
  'firstAgentMessageRenameError',
  'comment'
] as const satisfies readonly (keyof WorktreeMeta)[]

function isUnset(value: unknown): boolean {
  return value === undefined || value === null || value === ''
}

/** True when the name is what an unnamed checkout shows anyway: its branch or folder slug. */
export function isAutomaticWorktreeName(
  name: string | undefined,
  branch: string,
  worktreePath: string
): boolean {
  const folded = (name ?? '').trim().toLowerCase()
  if (!folded) {
    return true
  }
  const branchShort = branch.replace(/^refs\/heads\//, '').toLowerCase()
  const slugs = [
    branchShort,
    branchShort.split('/').pop() ?? '',
    basename(worktreePath).toLowerCase()
  ]
  return slugs.some((slug) => slug !== '' && slug === folded)
}

/** Updates that fill the survivor from its split twin; survivor-held values always win. */
export function planWorktreeCaseSplitMerge(
  survivor: WorktreeMeta,
  sibling: WorktreeMeta,
  options: { branch: string; survivorPath: string; siblingId: string }
): Partial<WorktreeMeta> {
  const updates: Partial<WorktreeMeta> = {}
  const fill = <K extends keyof WorktreeMeta>(key: K): void => {
    if (isUnset(survivor[key]) && !isUnset(sibling[key])) {
      updates[key] = sibling[key]
    }
  }
  if (
    isAutomaticWorktreeName(survivor.displayName, options.branch, options.survivorPath) &&
    !isUnset(sibling.displayName) &&
    !isAutomaticWorktreeName(sibling.displayName, options.branch, options.survivorPath)
  ) {
    updates.displayName = sibling.displayName
    updates.displayNameIsPinned = sibling.displayNameIsPinned ?? true
  }
  for (const key of [...CREATE_FIELDS, ...LINK_FIELDS, ...ROW_STATE_FIELDS]) {
    fill(key)
  }
  if (isUnset(survivor.linkedLinearIssue) && !isUnset(sibling.linkedLinearIssue)) {
    for (const key of LINEAR_FIELDS) {
      updates[key] = sibling[key]
    }
  }
  const survivorItems = survivor.linkedItems ?? []
  const survivorKeys = new Set(survivorItems.map(getWorkspaceAttachmentKey))
  const added = (sibling.linkedItems ?? []).filter(
    (item) => !survivorKeys.has(getWorkspaceAttachmentKey(item))
  )
  if (added.length > 0) {
    updates.linkedItems = [...survivorItems, ...added]
  }
  const priors = survivor.priorWorktreeIds ?? []
  const nextPriors = [
    ...new Set([...priors, ...(sibling.priorWorktreeIds ?? []), options.siblingId])
  ]
  if (nextPriors.length !== priors.length) {
    // Terminal sessions bound to the twin's id still resolve to the survivor.
    updates.priorWorktreeIds = nextPriors
  }
  return updates
}

const OWNER_KEYED_SESSION_FIELDS = Object.entries(WORKSPACE_SESSION_WORKTREE_REFERENCE_KIND)
  .filter(([, kind]) => kind.startsWith('owner-keyed'))
  .map(([field]) => field)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export type SessionRekeyResult = {
  session: WorkspaceSessionState
  changed: boolean
  /** Session fields where the survivor already had an entry, so the twin's entry stayed put. */
  keptFields: string[]
}

/** Move the twin's session entries to the survivor without ever replacing one the survivor owns. */
export function rekeySessionWithoutOverwrite(
  current: WorkspaceSessionState,
  siblingId: string,
  survivorId: string
): SessionRekeyResult {
  const session = structuredClone(current)
  const keyPairs: [string, string][] = [
    [siblingId, survivorId],
    [worktreeWorkspaceKey(siblingId), worktreeWorkspaceKey(survivorId)]
  ]
  const held: { field: string; key: string; value: unknown }[] = []
  for (const field of OWNER_KEYED_SESSION_FIELDS) {
    const record: unknown = Reflect.get(session, field)
    if (!isRecord(record)) {
      continue
    }
    for (const [siblingKey, survivorKey] of keyPairs) {
      if (siblingKey in record && survivorKey in record) {
        held.push({ field, key: siblingKey, value: record[siblingKey] })
        delete record[siblingKey]
      }
    }
  }
  const state = { ...getDefaultPersistedState(''), workspaceSession: session }
  const changed = migrateWorktreeIdentity(state, siblingId, survivorId)
  for (const { field, key, value } of held) {
    const record: unknown = Reflect.get(state.workspaceSession, field)
    if (isRecord(record)) {
      record[key] = value
    }
  }
  return {
    session: state.workspaceSession,
    changed,
    keptFields: [...new Set(held.map((entry) => entry.field))]
  }
}
