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
  getProjectCloneKey,
  trackProjectClone,
  type ProjectCloneOutcome
} from './project-clone-in-flight'

/** The host a clone is for, kept with its row so the picker and the status line name the same host. */
export type RunTargetCloneTarget = {
  hostId: NeedsSetupProjectHostOption['hostId']
  label: string
  option: NeedsSetupProjectHostOption
}

export type RunTargetCloneStatus =
  | { kind: 'idle' }
  | { kind: 'cloning'; target: RunTargetCloneTarget }
  | {
      kind: 'folder-taken'
      target: RunTargetCloneTarget
      folderName: string
      /** The taken folder as a host path, for adopting it instead. */
      path: string
      suggestion: string
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

type CloneRequest = {
  option: NeedsSetupProjectHostOption
  url: string
  destinationOverride: string
  folderName?: string
  /** True once the user moved to another host or dropped the request, so nothing should be cloned. */
  isSuperseded: () => boolean
}

/**
 * Clones a project onto the host the user just picked, with no dialog.
 *
 * Starts from the composer's own defaults and reports every outcome where the picker was: a host
 * that cannot clone never reaches here (its row says why), and a failure keeps the error, Retry and
 * "Use existing folder" on the row instead of a toast. The clone itself is shared through a
 * registry, so a second pick — or a composer reopened mid-clone — joins it and still learns how it
 * turned out.
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
  // Only the host the user is currently waiting on may drive the status, and the only thing that
  // abandons a clone: another host pick, or `clear()`. Unmount leaves it alone, so a clone a closed
  // composer was still waiting on keeps running — and a reopened composer can still join it.
  const pendingKeyRef = useRef<string | null>(null)
  // The clone a destination override was written for, kept across clears: a path names one machine,
  // so it must not follow the user to another host — but a value typed while nothing is pending
  // belongs to whatever host is picked next.
  const destinationKeyRef = useRef<string | null>(null)
  // A closed composer must not be retargeted by a clone it started before it went away.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const setOverrides = useCallback((next: Partial<RunTargetCloneOverrides>): void => {
    if (next.destination !== undefined) {
      destinationKeyRef.current = pendingKeyRef.current
    }
    setOverridesState((current) => ({ ...current, ...next }))
  }, [])

  const cloneOnce = useCallback(
    async ({
      option,
      url,
      destinationOverride,
      folderName,
      isSuperseded
    }: CloneRequest): Promise<ProjectCloneOutcome> => {
      if (!url) {
        return {
          kind: 'failed',
          message: translate(
            'auto.components.NewWorkspaceComposerCard.cloneNeedsRemote',
            'This project has no remote to clone from. Use a folder that already exists on this host.'
          )
        }
      }
      if (!projectId) {
        return { kind: 'abandoned' }
      }
      const destination =
        destinationOverride ||
        (await resolveCloneParentForHost({
          settings,
          hostIds: [option.hostId],
          ...(layoutMode ? { layoutMode } : {})
        }))
      // Why here as well as at the outcome: the host lookup is the long wait, and a user who has
      // moved on must not end up with a checkout on a host they abandoned.
      if (isSuperseded()) {
        return { kind: 'abandoned' }
      }
      if (!destination.trim()) {
        return {
          kind: 'failed',
          message: translate(
            'auto.components.NewWorkspaceComposerCard.cloneNeedsDestination',
            'Orca could not find a folder to clone into on this host. Use a folder that already exists there.'
          )
        }
      }
      const cloneArgs = {
        url,
        destination,
        ...(folderName ? { folderName } : {})
      }
      const check = await checkCloneTargetOn(getProjectCloneCheckTarget(option.hostId), cloneArgs)
      if (isSuperseded()) {
        return { kind: 'abandoned' }
      }
      if (check?.status === 'taken') {
        return {
          kind: 'folder-taken',
          folderName: check.folderName,
          path: joinHostPath(destination, check.folderName),
          suggestion: check.suggestedFolderName ?? check.folderName,
          canUseExistingFolder: check.reason === 'not-empty'
        }
      }
      try {
        const result = await setupProjectClone(
          { projectId, hostId: option.hostId, ...cloneArgs, displayName: projectName },
          { onFailure: 'throw' }
        )
        if (!result) {
          return {
            kind: 'failed',
            message: translate(
              'auto.components.NewWorkspaceComposerCard.cloneSetupFailed',
              'Cloned, but Orca could not add the project on this host.'
            )
          }
        }
        return { kind: 'provisioned', setupId: result.setup.id }
      } catch (error) {
        return {
          kind: 'failed',
          message:
            readIpcErrorMessage(error) ??
            translate(
              'auto.components.NewWorkspaceComposerCard.cloneFailed',
              'Cloning failed on this host.'
            )
        }
      }
    },
    [layoutMode, projectId, projectName, settings, setupProjectClone]
  )

  const run = useCallback(
    (option: NeedsSetupProjectHostOption, requestedFolderName?: string): void => {
      if (!projectId) {
        return
      }
      const key = getProjectCloneKey(projectId, option.hostId)
      // Why keyed rather than counted: a second pick of the same host joins the running clone, and
      // that clone's own continuation has to stay live or the composer waits on it forever.
      pendingKeyRef.current = key
      const hostChanged = destinationKeyRef.current !== null && destinationKeyRef.current !== key
      destinationKeyRef.current = key
      const destinationOverride = hostChanged ? '' : overrides.destination.trim()
      if (hostChanged && overrides.destination) {
        setOverridesState((current) => ({ ...current, destination: '' }))
      }
      const target: RunTargetCloneTarget = { hostId: option.hostId, label: option.label, option }
      setStatus({ kind: 'cloning', target })

      const promise = trackProjectClone(key, () =>
        cloneOnce({
          option,
          url: overrides.url.trim() || defaultCloneUrl.trim(),
          destinationOverride,
          // Why the key alone and not the mount: a reopened composer may be waiting on this same
          // clone, so only the user moving on — another host pick, or `clear()` on a project
          // switch — may abandon it. A closed composer leaves the ref alone.
          isSuperseded: () => pendingKeyRef.current !== key,
          ...(requestedFolderName ? { folderName: requestedFolderName } : {})
        })
      )
      const applyOutcome = (outcome: ProjectCloneOutcome): void => {
        // Why both: an unmounted composer and one that moved to another host must not be retargeted.
        if (!mountedRef.current || pendingKeyRef.current !== key || outcome.kind === 'abandoned') {
          return
        }
        if (outcome.kind === 'provisioned') {
          pendingKeyRef.current = null
          setStatus({ kind: 'idle' })
          onProvisioned(
            getProjectHostSetupSelectionKey({ id: outcome.setupId, hostId: option.hostId }),
            'cloned'
          )
          return
        }
        setStatus(
          outcome.kind === 'failed'
            ? { kind: 'failed', target, message: outcome.message }
            : {
                kind: 'folder-taken',
                target,
                folderName: outcome.folderName,
                path: outcome.path,
                suggestion: outcome.suggestion,
                canUseExistingFolder: outcome.canUseExistingFolder
              }
        )
      }
      void promise.then(applyOutcome, () => {
        // cloneOnce reports its own failures; this only stops a derived rejection going unhandled.
      })
    },
    [cloneOnce, defaultCloneUrl, onProvisioned, overrides.destination, overrides.url, projectId]
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
