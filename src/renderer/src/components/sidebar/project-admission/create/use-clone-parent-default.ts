import { useEffect, useState } from 'react'
import type { WorktreeLayoutMode } from '../../../../../../shared/orca-workspace-layout'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../../../shared/execution-host'
import { getHostSettingOverrideForIds } from '../../../../../../shared/host-setting-overrides'
import { browseRuntimeServerDirectory } from '@/runtime/files/reads/runtime-server-directory-browser'
import { getCloneParentForHost, type CloneParentSettings } from './clone-defaults'

/** One clone destination rule for both clone UIs: the host's stored root, else its own home. */
export function useCloneParentDefault({
  settings,
  hostIds,
  layoutMode,
  enabled
}: {
  settings: CloneParentSettings | null | undefined
  hostIds: readonly ExecutionHostId[]
  layoutMode?: WorktreeLayoutMode
  enabled: boolean
}): { parent: string; pending: boolean } {
  const environmentId =
    hostIds
      .map((hostId) => parseExecutionHostId(hostId))
      .find((parsed) => parsed?.kind === 'runtime')?.environmentId ?? null
  const hasStoredRoot = Boolean(
    getHostSettingOverrideForIds(settings, hostIds, 'defaultRepoRoot') ??
    getHostSettingOverrideForIds(settings, hostIds, 'defaultWorktreeLocation')
  )
  // Only a host with nothing stored needs its home read, and only once per host.
  const shouldProbe = enabled && environmentId !== null && !hasStoredRoot
  const [hostHome, setHostHome] = useState<string | null>(null)
  const [probeFailed, setProbeFailed] = useState(false)
  useEffect(() => {
    setHostHome(null)
    setProbeFailed(false)
    if (!shouldProbe || environmentId === null) {
      return
    }
    let cancelled = false
    void browseRuntimeServerDirectory(environmentId, '~')
      .then((listing) => {
        if (!cancelled) {
          setHostHome(listing.resolvedPath)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setProbeFailed(true)
        }
      })
    return () => {
      cancelled = true
    }
  }, [environmentId, shouldProbe])
  return {
    parent: getCloneParentForHost({ settings, hostIds, layoutMode, hostHome }),
    pending: shouldProbe && hostHome === null && !probeFailed
  }
}
