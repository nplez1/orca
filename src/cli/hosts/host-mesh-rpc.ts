import type { HostMeshPairStatus } from '../../shared/host-mesh/host-mesh-contract'
import type { RuntimeRpcSuccess } from '../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { RuntimeClientError } from '../runtime/connection/types'
import type { RuntimeClient } from '../runtime/client'

/**
 * The mesh surface this CLI calls, named once.
 *
 * Why not the contract's `hostMesh.join` / `.sync` / `.remove`: those six are peer-facing — a member calls them
 * with sealed offers addressed to another machine. A person at a terminal asks their own runtime instead,
 * and these names mirror the driver calls `src/main/host-mesh/host-mesh-runtime.ts` exports.
 *
 * They are not registered yet: `src/main/runtime/rpc/methods/host-mesh.ts` answers only the six peer-facing
 * methods, so every command here fails with "does not answer hostMesh.<method>" until that file adds them.
 */
export const HOST_MESH_SNAPSHOT_METHOD = 'hostMesh.snapshot'
export const HOST_MESH_JOIN_METHOD = 'hostMesh.joinGroup'
export const HOST_MESH_SYNC_METHOD = 'hostMesh.syncNow'
export const HOST_MESH_REMOVE_METHOD = 'hostMesh.removeMember'
export const HOST_MESH_LEAVE_METHOD = 'hostMesh.leaveGroup'

/** One member as a surface renders it: the row plus how usable the link to it actually is. */
export type HostMeshMemberRow = {
  hostKey: string
  label: string
  /** The member that vouched for this one, as a host key; absent for the host that created the group. */
  introducedBy?: string
  status: HostMeshPairStatus
  /** Null when this host holds no environment for the member, which is what a half-join looks like. */
  environmentId: string | null
}

export type HostMeshSummaryRow = {
  memberCount: number
  completePairs: number
  halfPairs: number
  missingPairs: number
  atCap: boolean
}

export type HostMeshSnapshotRow = {
  inGroup: boolean
  groupId: string
  selfKey: string
  members: HostMeshMemberRow[]
  summary: HostMeshSummaryRow
  /** A line to show verbatim when the last pass failed. */
  lastError: string | null
}

export type HostMeshJoinRow =
  | { kind: 'joined'; snapshot: HostMeshSnapshotRow; muted: string[] }
  | { kind: 'refused'; reason: string; snapshot: HostMeshSnapshotRow }

const PAIR_STATUSES: readonly HostMeshPairStatus[] = ['complete', 'half', 'missing']

function unreadable(what: string): RuntimeClientError {
  return new RuntimeClientError(
    'incompatible_runtime',
    `This Orca runtime answered host mesh ${what} in a shape this CLI cannot read. Update Orca on that host and try again.`
  )
}

/**
 * Why refuse instead of rendering what parsed: a group table that silently drops a member reads as a healthy
 * group, and the one thing this command exists for is showing that a member is not fully joined.
 */
export function readHostMeshSnapshot(value: unknown): HostMeshSnapshotRow {
  if (typeof value !== 'object' || value === null) {
    throw unreadable('state')
  }
  const candidate = value as Partial<HostMeshSnapshotRow>
  if (
    typeof candidate.inGroup !== 'boolean' ||
    typeof candidate.groupId !== 'string' ||
    typeof candidate.selfKey !== 'string' ||
    !Array.isArray(candidate.members) ||
    !isSummary(candidate.summary)
  ) {
    throw unreadable('state')
  }
  const members = candidate.members.map((member) => readMember(member))
  return {
    inGroup: candidate.inGroup,
    groupId: candidate.groupId,
    selfKey: candidate.selfKey,
    members,
    summary: candidate.summary,
    lastError: typeof candidate.lastError === 'string' ? candidate.lastError : null
  }
}

function readMember(value: unknown): HostMeshMemberRow {
  if (typeof value !== 'object' || value === null) {
    throw unreadable('member')
  }
  const member = value as Partial<HostMeshMemberRow>
  if (
    typeof member.hostKey !== 'string' ||
    typeof member.label !== 'string' ||
    !PAIR_STATUSES.includes(member.status as HostMeshPairStatus)
  ) {
    throw unreadable('member')
  }
  return {
    hostKey: member.hostKey,
    label: member.label,
    ...(typeof member.introducedBy === 'string' ? { introducedBy: member.introducedBy } : {}),
    status: member.status as HostMeshPairStatus,
    environmentId: typeof member.environmentId === 'string' ? member.environmentId : null
  }
}

function isSummary(value: unknown): value is HostMeshSummaryRow {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const summary = value as Partial<HostMeshSummaryRow>
  return (
    typeof summary.memberCount === 'number' &&
    typeof summary.completePairs === 'number' &&
    typeof summary.halfPairs === 'number' &&
    typeof summary.missingPairs === 'number'
  )
}

export function readHostMeshJoin(value: unknown): HostMeshJoinRow {
  if (typeof value !== 'object' || value === null) {
    throw unreadable('join')
  }
  const outcome = value as Partial<HostMeshJoinRow>
  if (outcome.kind === 'joined') {
    return {
      kind: 'joined',
      snapshot: readHostMeshSnapshot(outcome.snapshot),
      muted: Array.isArray(outcome.muted) ? outcome.muted.filter(isString) : []
    }
  }
  if (outcome.kind === 'refused') {
    return {
      kind: 'refused',
      reason: typeof outcome.reason === 'string' ? outcome.reason : 'unknown',
      snapshot: readHostMeshSnapshot(outcome.snapshot)
    }
  }
  throw unreadable('join')
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

/** Older builds answer `method_not_found`; name the method that is missing rather than "Unknown method". */
function translateMeshError(error: unknown, method: string): never {
  if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
    throw new RuntimeClientError(
      'incompatible_runtime',
      `This Orca runtime does not answer ${method}, so it has no host mesh groups for the CLI. Update Orca on that host and try again.`,
      { method }
    )
  }
  throw error
}

export async function callHostMesh<T>(
  client: RuntimeClient,
  method: string,
  params?: unknown
): Promise<RuntimeRpcSuccess<T>> {
  try {
    return await client.call<T>(method, params)
  } catch (error) {
    return translateMeshError(error, method)
  }
}
