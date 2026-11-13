import type { WorktreeLayoutMode } from '../../../../../../shared/orca-workspace-layout'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../../../shared/execution-host'
import { canonicalHostIdOrder } from '../../../../../../shared/execution-host/managed-orcad-execution-host'
import { getHostSettingOverrideForIds } from '../../../../../../shared/host-setting-overrides'
import { resolveCheckoutParent } from '../../../../../../shared/host-repo-root'
import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import { isAbsoluteOrHomeFolderPath } from '@/lib/host-folder-path'

export type CloneParentSettings = {
  workspaceDir?: string | null
  hostSettingOverrides?: GlobalSettings['hostSettingOverrides']
}

// fork-comment-ok: a relative root cannot name a folder on another machine, and that host's platform is unknown here.
export function getUsableStoredHostRoot(
  settings: CloneParentSettings | null | undefined,
  hostIds: readonly ExecutionHostId[],
  key: 'defaultRepoRoot' | 'defaultWorktreeLocation'
): string | undefined {
  const stored = getHostSettingOverrideForIds(settings, hostIds, key)
  return stored && isAbsoluteOrHomeFolderPath(stored, true) ? stored : undefined
}

function readHostIds(
  hostIds: readonly ExecutionHostId[],
  overrideHostIds: readonly ExecutionHostId[]
): ExecutionHostId[] {
  return canonicalHostIdOrder([...hostIds, ...overrideHostIds])
}

// fork-comment-ok: one rule for the hook and the awaited resolver, so the two cannot drift.
export function needsHostHomeProbe(
  settings: CloneParentSettings | null | undefined,
  hostIds: readonly ExecutionHostId[],
  overrideHostIds: readonly ExecutionHostId[] = hostIds
): { environmentId: string | null; probe: boolean } {
  const environmentId =
    hostIds
      .map((hostId) => parseExecutionHostId(hostId))
      .find((parsed) => parsed?.kind === 'runtime')?.environmentId ?? null
  const storedHostIds = readHostIds(hostIds, overrideHostIds)
  const hasStoredRoot = Boolean(
    getUsableStoredHostRoot(settings, storedHostIds, 'defaultRepoRoot') ??
    getUsableStoredHostRoot(settings, storedHostIds, 'defaultWorktreeLocation')
  )
  return { environmentId, probe: environmentId !== null && !hasStoredRoot }
}

/** Where a clone lands for a host: the same rule create-project uses, so the two cannot diverge. */
export function getCloneParentForHost({
  settings,
  hostIds,
  overrideHostIds = hostIds,
  layoutMode = 'repo-nested',
  hostHome
}: {
  settings: CloneParentSettings | null | undefined
  hostIds: readonly ExecutionHostId[]
  overrideHostIds?: readonly ExecutionHostId[]
  layoutMode?: WorktreeLayoutMode
  /** The machine's home directory, when the caller could probe it. */
  hostHome?: string | null
}): string {
  const parsedIds = hostIds
    .map((hostId) => parseExecutionHostId(hostId))
    .filter((parsed) => parsed !== null)
  const isLocal = parsedIds.some((parsed) => parsed.kind === 'local')
  // Cloning onto an SSH-only machine is refused, so it never gets a destination. A merged pair keeps
  // its server id, which is where the folder is stored.
  if (!isLocal && !parsedIds.some((parsed) => parsed.kind === 'runtime')) {
    return ''
  }
  // fork-comment-ok: a relative workspace dir is a per-project location, so it names no clone destination.
  const workspaceDir = settings?.workspaceDir ?? ''
  const storedHostIds = readHostIds(hostIds, overrideHostIds)
  return resolveCheckoutParent({
    storedRepoRoot: getUsableStoredHostRoot(settings, storedHostIds, 'defaultRepoRoot'),
    // fork-comment-ok: never this computer's workspaceDir for a remote host — it names another
    // machine's disk, so a remote host falls back to its own probed home instead.
    storedWorktreeRoot:
      getUsableStoredHostRoot(settings, storedHostIds, 'defaultWorktreeLocation') ??
      (isLocal && isAbsoluteOrHomeFolderPath(workspaceDir, true) ? workspaceDir : ''),
    layoutMode,
    // Only a runtime host's home is probed, so a local host never reads one here.
    hostHome: isLocal ? null : hostHome
  })
}

export function getCloneDestinationAutoFill({
  step,
  cloneDestination,
  cloneStepAutoFilled,
  parent
}: {
  step: string
  cloneDestination: string
  cloneStepAutoFilled: boolean
  /** The host's resolved clone parent, from `getCloneParentForHost`. */
  parent: string
}): { destination: string } | null {
  if (step !== 'clone' || cloneStepAutoFilled || cloneDestination || !parent) {
    return null
  }
  return { destination: parent }
}
