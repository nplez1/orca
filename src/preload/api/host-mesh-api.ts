import type { HostMeshSettings } from '../../shared/host-mesh/host-mesh-admission'
import type { HostMeshPairStatus } from '../../shared/host-mesh/host-mesh-contract'
import type { HostMeshGroupSummary } from '../../shared/host-mesh/host-mesh-membership'

/**
 * The mesh as a surface renders it.
 *
 * Why mirrored from `main/host-mesh/host-mesh-driver-contract.ts` instead of imported: the web project
 * does not include `src/main`, so a renderer type can only come from `shared` or from this folder.
 */

/** One member, with how usable the link to it actually is. */
export type HostMeshMemberView = {
  hostKey: string
  label: string
  introducedBy?: string
  /** `complete` means both directions exist; `half` means one host believes it is paired and the other does not. */
  status: HostMeshPairStatus
  /** Null when this host holds no environment for the member, which is what a half-join looks like. */
  environmentId: string | null
}

export type HostMeshSnapshot = {
  inGroup: boolean
  groupId: string
  selfKey: string
  members: HostMeshMemberView[]
  summary: HostMeshGroupSummary
  settings: HostMeshSettings
  /** A line a surface can show verbatim when the last pass failed, or null. */
  lastError: string | null
}

export type HostMeshJoinOutcome =
  | { kind: 'joined'; snapshot: HostMeshSnapshot; muted: string[] }
  | { kind: 'refused'; reason: string; snapshot: HostMeshSnapshot }

export type HostMeshApi = {
  read: () => Promise<HostMeshSnapshot>
  /** Pair this host with every member of the group the given paired environment belongs to. */
  join: (environmentId: string) => Promise<HostMeshJoinOutcome>
  sync: () => Promise<HostMeshSnapshot>
  remove: (hostKey: string) => Promise<HostMeshSnapshot>
  leave: () => Promise<HostMeshSnapshot>
  settings: (patch: Partial<HostMeshSettings>) => Promise<HostMeshSnapshot>
}
