import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  LOCAL_EXECUTION_HOST_ID,
  getWorktreeExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import { isDetachedHeadWorkspace } from '../../../../../../shared/worktree/visibility/workspace-kinds'
import { branchName } from '../../../../lib/source-control/branches/branch-name'
import {
  composeWorktreeHostIdentity,
  getWorktreeHostIdentity
} from '../../../../../../shared/worktree/host-qualified-identity'
import {
  getProjectGroupingForRepo,
  type ProjectGroupingIndex
} from '../../../../../../shared/sidebar-list/sections/project-section-grouping'
import type { BranchGroupMember } from '../../../../../../shared/sidebar-list/row-types'

// `|` is legal inside a branch, so the section and branch need a separator that
// cannot appear in either.
const BRANCH_GROUP_SEPARATOR = '\u0000'

/** Local host first, then host id ascending, so the default card is stable. */
function compareHostIds(left: ExecutionHostId, right: ExecutionHostId): number {
  if (left === right) {
    return 0
  }
  if (left === LOCAL_EXECUTION_HOST_ID) {
    return -1
  }
  if (right === LOCAL_EXECUTION_HOST_ID) {
    return 1
  }
  return left < right ? -1 : 1
}

/** Eligibility shared by the sidebar card and the tab strip: a real branch, not detached. */
function normalizeBranch(worktree: Worktree): string | null {
  const branch = branchName(worktree.branch ?? '').trim()
  return branch && !isDetachedHeadWorkspace(worktree) ? branch : null
}

/**
 * Stable identity for one project's branch, computed identically by the sidebar
 * card and the tab strip so they share one host selection.
 */
export function getBranchGroupKeyForWorktree(
  worktree: Worktree,
  repoMap: ReadonlyMap<string, Repo>,
  projectIndex: ProjectGroupingIndex | null
): string | null {
  const branch = normalizeBranch(worktree)
  if (!branch) {
    return null
  }
  const sectionKey = getProjectGroupingForRepo(worktree.repoId, repoMap, projectIndex).key
  return `${sectionKey}${BRANCH_GROUP_SEPARATOR}${branch}`
}

/**
 * One member per host, in display order, or null when the branch cannot be
 * consolidated. Two checkouts of one branch on the same host are ambiguous —
 * hiding one behind the dropdown — so that branch keeps its own rows.
 */
export function buildHostOrderedMembers(
  candidates: readonly { worktree: Worktree; repo: Repo | undefined }[],
  repoMap: ReadonlyMap<string, Repo>,
  defaultHostId: ExecutionHostId,
  hostLabelById: ReadonlyMap<string, string> | undefined
): BranchGroupMember[] | null {
  const candidateByHostId = new Map<
    ExecutionHostId,
    { worktree: Worktree; repo: Repo | undefined }
  >()
  for (const candidate of candidates) {
    const hostId = getWorktreeExecutionHostId(
      candidate.worktree,
      candidate.repo ?? repoMap.get(candidate.worktree.repoId),
      defaultHostId
    )
    if (candidateByHostId.has(hostId)) {
      return null
    }
    candidateByHostId.set(hostId, candidate)
  }
  if (candidateByHostId.size < 2) {
    return null
  }
  return [...candidateByHostId.entries()]
    .sort(([left], [right]) => compareHostIds(left, right))
    .map(([hostId, candidate]) => ({
      worktree: candidate.worktree,
      repo: candidate.repo,
      hostId,
      hostLabel: hostLabelById?.get(hostId) ?? hostId
    }))
}

/**
 * Sibling checkouts of one branch across hosts, local-first, for the tab strip.
 * Mirrors the sidebar merge so the two surfaces cannot disagree.
 */
export function getBranchGroupMembersForWorktree(args: {
  worktree: Worktree
  worktrees: readonly Worktree[]
  repoMap: ReadonlyMap<string, Repo>
  projectIndex: ProjectGroupingIndex | null
  defaultHostId: ExecutionHostId
  hostLabelById?: ReadonlyMap<string, string>
}): BranchGroupMember[] | null {
  const { worktree, worktrees, repoMap, projectIndex, defaultHostId, hostLabelById } = args
  const key = getBranchGroupKeyForWorktree(worktree, repoMap, projectIndex)
  if (!key) {
    return null
  }
  const candidates = worktrees
    .filter((candidate) => getBranchGroupKeyForWorktree(candidate, repoMap, projectIndex) === key)
    .map((candidate) => ({ worktree: candidate, repo: repoMap.get(candidate.repoId) }))
  return buildHostOrderedMembers(candidates, repoMap, defaultHostId, hostLabelById)
}

export type BranchGroupSelection = {
  selectedHostId: ExecutionHostId
  /** The member the card renders. */
  member: BranchGroupMember
  activeMember?: BranchGroupMember
  /** True when the card represents the active workspace. */
  isActiveGroup: boolean
}

/**
 * Resolves which host a Group by branch card shows. The explicit dropdown choice
 * wins; otherwise the card follows the active workspace so navigating to a
 * sibling host highlights the merged card, and finally falls back local-first.
 */
export function resolveBranchGroupSelection(args: {
  members: readonly BranchGroupMember[]
  groupKey: string
  selection: Readonly<Record<string, ExecutionHostId>>
  activeWorktreeId: string | null
  activeExecutionHostId: ExecutionHostId | null
}): BranchGroupSelection {
  const { members, groupKey, selection, activeWorktreeId, activeExecutionHostId } = args
  const activeMember = members.find(
    (member) =>
      member.worktree.id === activeWorktreeId &&
      (!activeExecutionHostId ||
        getWorktreeHostIdentity({ id: member.worktree.id, hostId: member.hostId }) ===
          composeWorktreeHostIdentity(activeExecutionHostId, member.worktree.id))
  )
  const selectedHostId = selection[groupKey] ?? activeMember?.hostId ?? members[0].hostId
  const member = members.find((candidate) => candidate.hostId === selectedHostId) ?? members[0]
  return {
    selectedHostId,
    member,
    activeMember,
    isActiveGroup: Boolean(activeMember) && member.hostId === activeMember?.hostId
  }
}
