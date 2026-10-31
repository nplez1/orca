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

const OWNER_KEYED_SESSION_FIELDS = (
  Object.keys(WORKSPACE_SESSION_WORKTREE_REFERENCE_KIND) as (keyof WorkspaceSessionState)[]
).filter((field) => WORKSPACE_SESSION_WORKTREE_REFERENCE_KIND[field].startsWith('owner-keyed'))

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** True when this session already holds state for the worktree under either of its keys. */
export function sessionOwnsWorktree(session: WorkspaceSessionState, worktreeId: string): boolean {
  const keys = [worktreeId, worktreeWorkspaceKey(worktreeId)]
  for (const field of OWNER_KEYED_SESSION_FIELDS) {
    const record: unknown = session[field]
    if (!isRecord(record)) {
      continue
    }
    if (keys.some((key) => key in record)) {
      return true
    }
  }
  return false
}

export type SessionMoveResult = {
  session: WorkspaceSessionState
  moved: boolean
}

/**
 * Move the twin's session to the survivor as one unit, and only onto an owner that has none.
 *
 * Why all-or-nothing: the owner-keyed fields describe one tab set across several collections, so
 * moving them piecemeal leaves a survivor whose active tab is not in its own tab list — and the
 * twin's record removal deletes whatever was left behind under its id.
 */
export function moveSessionToSurvivor(
  current: WorkspaceSessionState,
  siblingId: string,
  survivorId: string
): SessionMoveResult {
  if (!sessionOwnsWorktree(current, siblingId) || sessionOwnsWorktree(current, survivorId)) {
    return { session: current, moved: false }
  }
  const state = { ...getDefaultPersistedState(''), workspaceSession: structuredClone(current) }
  const moved = migrateWorktreeIdentity(state, siblingId, survivorId)
  return { session: state.workspaceSession, moved }
}
