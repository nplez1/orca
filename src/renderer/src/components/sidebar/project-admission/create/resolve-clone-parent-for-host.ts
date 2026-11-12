import type { WorktreeLayoutMode } from '../../../../../../shared/orca-workspace-layout'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { browseRuntimeServerDirectory } from '@/runtime/files/reads/runtime-server-directory-browser'
import {
  getCloneParentForHost,
  needsHostHomeProbe,
  type CloneParentSettings
} from './clone-defaults'

/** Reads a remote machine's home folder. Injected so the rule is testable without an RPC. */
export type HostHomeProbe = (environmentId: string) => Promise<string | null>

export const probeRuntimeHostHome: HostHomeProbe = async (environmentId) => {
  try {
    return (await browseRuntimeServerDirectory(environmentId, '~')).resolvedPath
  } catch {
    return null
  }
}

/**
 * The folder a clone lands in on a host, resolved to a value rather than to a state.
 *
 * Same rule as `useCloneParentDefault`, for callers that cannot wait on a render: only a runtime
 * host with nothing stored needs its home read, and a failed read leaves the destination empty
 * instead of falling back to this computer's `workspaceDir`.
 */
export async function resolveCloneParentForHost({
  settings,
  hostIds,
  overrideHostIds,
  layoutMode,
  probeHostHome = probeRuntimeHostHome
}: {
  settings: CloneParentSettings | null | undefined
  hostIds: readonly ExecutionHostId[]
  /** Every id the machine answers to, so a folder stored under a merged alias is found. */
  overrideHostIds?: readonly ExecutionHostId[]
  layoutMode?: WorktreeLayoutMode
  probeHostHome?: HostHomeProbe
}): Promise<string> {
  const { environmentId, probe } = needsHostHomeProbe(settings, hostIds, overrideHostIds)
  const hostHome = probe && environmentId ? await probeHostHome(environmentId) : null
  return getCloneParentForHost({ settings, hostIds, overrideHostIds, layoutMode, hostHome })
}

/** A run-target row's clone destination: the ids it derives decide eligibility, the whole machine the folder. */
export function resolveRunTargetCloneParent({
  settings,
  option,
  layoutMode
}: {
  settings: CloneParentSettings | null | undefined
  option: { hostId: ExecutionHostId; equivalentHostIds?: readonly ExecutionHostId[] }
  layoutMode?: WorktreeLayoutMode
}): Promise<string> {
  return resolveCloneParentForHost({
    settings,
    hostIds: [option.hostId],
    ...(option.equivalentHostIds ? { overrideHostIds: option.equivalentHostIds } : {}),
    ...(layoutMode ? { layoutMode } : {})
  })
}
