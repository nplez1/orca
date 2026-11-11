import type { WorktreeLayoutMode } from '../../../../../../shared/orca-workspace-layout'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../../../shared/execution-host'
import { getHostSettingOverrideForIds } from '../../../../../../shared/host-setting-overrides'
import { browseRuntimeServerDirectory } from '@/runtime/files/reads/runtime-server-directory-browser'
import { getCloneParentForHost, type CloneParentSettings } from './clone-defaults'

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
  layoutMode,
  probeHostHome = probeRuntimeHostHome
}: {
  settings: CloneParentSettings | null | undefined
  hostIds: readonly ExecutionHostId[]
  layoutMode?: WorktreeLayoutMode
  probeHostHome?: HostHomeProbe
}): Promise<string> {
  const environmentId =
    hostIds
      .map((hostId) => parseExecutionHostId(hostId))
      .find((parsed) => parsed?.kind === 'runtime')?.environmentId ?? null
  const hasStoredRoot = Boolean(
    getHostSettingOverrideForIds(settings, hostIds, 'defaultRepoRoot') ??
    getHostSettingOverrideForIds(settings, hostIds, 'defaultWorktreeLocation')
  )
  const hostHome =
    environmentId !== null && !hasStoredRoot ? await probeHostHome(environmentId) : null
  return getCloneParentForHost({ settings, hostIds, layoutMode, hostHome })
}
