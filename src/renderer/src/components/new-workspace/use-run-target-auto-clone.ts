import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { WorktreeLayoutMode } from '../../../../shared/orca-workspace-layout'
import { joinHostPath } from '../../../../shared/host-path-join'
import { getProjectHostSetupSelectionKey } from '@/lib/project-host-setup-options'
import type { NeedsSetupProjectHostOption } from '@/lib/project-host-setup-options'
import { useAppStore } from '@/store'
import { getProjectCloneCheckTarget } from '@/store/projects/project-host-routing'
import { readIpcErrorMessage } from '@/lib/ipc-error'
import { translate } from '@/i18n/i18n'
import { checkCloneTargetOn } from '@/components/sidebar/project-admission/clone-folder/use-clone-folder-override'
import { resolveCloneParentForHost } from '@/components/sidebar/project-admission/create/resolve-clone-parent-for-host'
import type { ProjectHostSetupProvisioning } from './use-workspace-copy-target'
import {
  isProjectCloneInFlight,
  getProjectCloneKey,
  trackProjectClone
} from './project-clone-in-flight'

/** The host a clone is for, kept with its row so the picker and the status line name the same host. */
export type RunTargetCloneTarget = {
  hostId: NeedsSetupProjectHostOption['hostId']
  label: string
  option: NeedsSetupProjectHostOption
}

export type RunTargetCloneStatus =
  | { kind: 'idle' }
  | { kind: 'resolving'; target: RunTargetCloneTarget }
  | { kind: 'cloning'; target: RunTargetCloneTarget }
  | {
      kind: 'folder-taken'
      target: RunTargetCloneTarget
      folderName: string
      /** The taken folder as a host path, for adopting it instead. */
      path: string
      suggestion: string
      /** A non-empty folder may already be this project, so offer to adopt it instead. */
      canUseExistingFolder: boolean
    }
  | { kind: 'failed'; target: RunTargetCloneTarget; message: string }

/** Advanced-section values; empty means "use the default this composer derived". */
export type RunTargetCloneOverrides = { url: string; destination: string }

export type RunTargetAutoClone = {
  status: RunTargetCloneStatus
  overrides: RunTargetCloneOverrides
  setOverrides: (next: Partial<RunTargetCloneOverrides>) => void
  /** What an empty URL override falls back to, for the Advanced placeholder. */
  defaultUrl: string
  /** The host a clone is pending for; the picker shows it while no setup exists yet. */
  pendingHostId: NeedsSetupProjectHostOption['hostId'] | null
  /** True whenever a selection is unfinished, so Create cannot target the previously chosen host. */
  blocksCreate: boolean
  start: (option: NeedsSetupProjectHostOption) => void
  retry: () => void
  cloneAs: (folderName: string) => void
  clear: () => void
}

/**
 * Clones a project onto the host the user just picked, with no dialog.
 *
 * Starts from the composer's own defaults and reports every outcome where the picker was: a host
 * that cannot clone never reaches here (its row says why), and a failure keeps the error, Retry and
 * "Use existing folder" on the row instead of a toast.
 */
export function useRunTargetAutoClone({
  projectId,
  projectName,
  defaultCloneUrl,
  settings,
  layoutMode,
  onProvisioned
}: {
  projectId: string | null
  projectName: string
  /** The selected project's own remote, credentials already stripped. */
  defaultCloneUrl: string
  settings: GlobalSettings | null
  layoutMode: WorktreeLayoutMode | undefined
  onProvisioned: (setupId: string, provisioning: ProjectHostSetupProvisioning) => void
}): RunTargetAutoClone {
  const setupProjectClone = useAppStore((state) => state.setupProjectClone)
  const [status, setStatus] = useState<RunTargetCloneStatus>({ kind: 'idle' })
  const [overrides, setOverridesState] = useState<RunTargetCloneOverrides>({
    url: '',
    destination: ''
  })
  // Only the host the user is currently waiting on may drive the status; a clone they moved away
  // from still finishes on the host, but must not retarget the composer or overwrite its state.
  const pendingKeyRef = useRef<string | null>(null)
  // A closed composer must not be retargeted by a clone it started before it went away.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const setOverrides = useCallback((next: Partial<RunTargetCloneOverrides>): void => {
    setOverridesState((current) => ({ ...current, ...next }))
  }, [])

  const run = useCallback(
    (option: NeedsSetupProjectHostOption, requestedFolderName?: string): void => {
      if (!projectId) {
        return
      }
      const key = getProjectCloneKey(projectId, option.hostId)
      // Why keyed rather than counted: a second pick of the same host joins the running clone, and
      // that clone's own continuation has to stay live or the composer waits on it forever.
      const previousKey = pendingKeyRef.current
      pendingKeyRef.current = key
      const isCurrent = (): boolean => mountedRef.current && pendingKeyRef.current === key
      const target: RunTargetCloneTarget = { hostId: option.hostId, label: option.label, option }
      const url = overrides.url.trim() || defaultCloneUrl.trim()
      // Why dropped on a host change: a destination is a path on one machine, so carrying it to
      // another would clone into a folder the user never meant for that host. A URL is
      // host-independent, and a value typed before any host was chosen is kept for the first one.
      const hostChanged = previousKey !== null && previousKey !== key
      const destinationOverride = hostChanged ? '' : overrides.destination.trim()
      if (hostChanged && overrides.destination) {
        setOverridesState((current) => ({ ...current, destination: '' }))
      }
      const fail = (message: string): void => {
        if (isCurrent()) {
          setStatus({ kind: 'failed', target, message })
        }
      }

      setStatus({ kind: 'resolving', target })
      const runClone = async (): Promise<void> => {
        if (!url) {
          fail(
            translate(
              'auto.components.NewWorkspaceComposerCard.cloneNeedsRemote',
              'This project has no remote to clone from. Use a folder that already exists on this host.'
            )
          )
          return
        }
        const destination =
          destinationOverride ||
          (await resolveCloneParentForHost({
            settings,
            hostIds: [option.hostId],
            ...(layoutMode ? { layoutMode } : {})
          }))
        if (!isCurrent()) {
          return
        }
        if (!destination.trim()) {
          fail(
            translate(
              'auto.components.NewWorkspaceComposerCard.cloneNeedsDestination',
              'Orca could not find a folder to clone into on this host. Use a folder that already exists there.'
            )
          )
          return
        }
        setStatus({ kind: 'cloning', target })
        const cloneArgs = {
          url,
          destination,
          ...(requestedFolderName ? { folderName: requestedFolderName } : {})
        }
        const check = await checkCloneTargetOn(getProjectCloneCheckTarget(option.hostId), cloneArgs)
        if (!isCurrent()) {
          return
        }
        if (check?.status === 'taken') {
          setStatus({
            kind: 'folder-taken',
            target,
            folderName: check.folderName,
            path: joinHostPath(destination, check.folderName),
            suggestion: check.suggestedFolderName ?? check.folderName,
            canUseExistingFolder: check.reason === 'not-empty'
          })
          return
        }
        try {
          const result = await setupProjectClone(
            { projectId, hostId: option.hostId, ...cloneArgs, displayName: projectName },
            { onFailure: 'throw' }
          )
          if (!isCurrent()) {
            return
          }
          if (!result) {
            fail(
              translate(
                'auto.components.NewWorkspaceComposerCard.cloneSetupFailed',
                'Cloned, but Orca could not add the project on this host.'
              )
            )
            return
          }
          pendingKeyRef.current = null
          setStatus({ kind: 'idle' })
          onProvisioned(
            getProjectHostSetupSelectionKey({ id: result.setup.id, hostId: option.hostId }),
            'cloned'
          )
        } catch (error) {
          fail(
            readIpcErrorMessage(error) ??
              translate(
                'auto.components.NewWorkspaceComposerCard.cloneFailed',
                'Cloning failed on this host.'
              )
          )
        }
      }

      if (isProjectCloneInFlight(key)) {
        // Why join: this pair is already cloning, so a second request could only collide.
        setStatus({ kind: 'cloning', target })
        return
      }
      trackProjectClone(key, runClone)
    },
    [
      defaultCloneUrl,
      layoutMode,
      onProvisioned,
      overrides.destination,
      overrides.url,
      projectId,
      projectName,
      settings,
      setupProjectClone
    ]
  )

  const start = useCallback(
    (option: NeedsSetupProjectHostOption): void => {
      run(option)
    },
    [run]
  )

  const retry = useCallback((): void => {
    if (status.kind === 'failed' || status.kind === 'folder-taken') {
      run(status.target.option)
    }
  }, [run, status])

  const cloneAs = useCallback(
    (folderName: string): void => {
      if (status.kind === 'folder-taken' && folderName.trim()) {
        run(status.target.option, folderName.trim())
      }
    },
    [run, status]
  )

  const clear = useCallback((): void => {
    pendingKeyRef.current = null
    setStatus((current) => (current.kind === 'idle' ? current : { kind: 'idle' }))
  }, [])

  const defaultUrl = useMemo(() => defaultCloneUrl.trim(), [defaultCloneUrl])

  return {
    status,
    overrides,
    setOverrides,
    defaultUrl,
    pendingHostId: status.kind === 'idle' ? null : status.target.hostId,
    blocksCreate: status.kind !== 'idle',
    start,
    retry,
    cloneAs,
    clear
  }
}
