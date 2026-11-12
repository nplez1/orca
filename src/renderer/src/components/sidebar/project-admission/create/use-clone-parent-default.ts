import { useEffect, useState } from 'react'
import type { WorktreeLayoutMode } from '../../../../../../shared/orca-workspace-layout'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { browseRuntimeServerDirectory } from '@/runtime/files/reads/runtime-server-directory-browser'
import {
  getCloneParentForHost,
  needsHostHomeProbe,
  type CloneParentSettings
} from './clone-defaults'

/** One clone destination rule for both clone UIs: the host's stored root, else its own home. */
export function useCloneParentDefault({
  settings,
  hostIds,
  overrideHostIds,
  layoutMode,
  enabled
}: {
  settings: CloneParentSettings | null | undefined
  hostIds: readonly ExecutionHostId[]
  /** Every id the machine answers to, so a folder stored under a merged alias is found. */
  overrideHostIds?: readonly ExecutionHostId[]
  layoutMode?: WorktreeLayoutMode
  enabled: boolean
}): { parent: string; pending: boolean } {
  const { environmentId, probe } = needsHostHomeProbe(settings, hostIds, overrideHostIds)
  // Only a host with nothing stored needs its home read, and only once per host.
  const shouldProbe = enabled && probe
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
    parent: getCloneParentForHost({ settings, hostIds, overrideHostIds, layoutMode, hostHome }),
    pending: shouldProbe && hostHome === null && !probeFailed
  }
}
