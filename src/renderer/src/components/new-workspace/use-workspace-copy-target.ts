import { useCallback, useMemo, useState } from 'react'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import type { Worktree } from '../../../../shared/worktree/types'
import { branchName } from '@/lib/git-utils'
import {
  getProjectHostSetupSelectionKey,
  type ProjectHostSetupOption
} from '@/lib/project-host-setup-options'
import { useAppStore } from '@/store'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import { isLockedSourceHostTarget } from './locked-target-host'

/** How a project reached a host inside this composer; only our own clone makes the clone the copy. */
export type ProjectHostSetupProvisioning = 'existing-folder' | 'cloned'

export type WorkspaceCopyTargetInput = {
  /** Set only when the composer is copying an existing workspace, so every other mode is inert. */
  lockedWorkspaceBranch?: string
  sourceHostId?: ExecutionHostId
  sourceRuntimeOwnerEnvironmentId?: string
  projectHostSetupOptions: readonly ProjectHostSetupOption[]
  selectedProjectHostSetupId: string | null
  selectedRepoExecutionHostId?: ExecutionHostId | null
  selectedEphemeralVmRecipeId?: string | null
  /** The copy also recreates a fork remote, so its branch is not the checkout's own branch. */
  hasLockedPushTarget?: boolean
}

export type WorkspaceCopyTarget = {
  /** The chosen run target is where the copied workspace already lives. */
  lockedTargetIsSourceHost: boolean
  /** No host other than the source is configured, so the copy has nowhere to go yet. */
  onlySourceHostAvailable: boolean
  recordProvisionedSetup: (setupId: string, provisioning: ProjectHostSetupProvisioning) => void
  /** The workspace the copy would duplicate, when our own clone already checked its branch out. */
  resolveCloneLandedCopy: () => Promise<Worktree | null>
  /** Name of the host the copy would land on, for reporting the outcome. */
  selectedTargetHostLabel: string
}

/**
 * State for "add this workspace to another host".
 *
 * A default-branch copy into a host we just cloned has nothing left to create — the clone is the
 * copy — so this remembers which setups this composer cloned and answers whether the copied
 * branch is already checked out there. A checkout that existed before this composer opened is
 * never in that set, so it stays a refusal.
 */
export function useWorkspaceCopyTarget(input: WorkspaceCopyTargetInput): WorkspaceCopyTarget {
  const {
    lockedWorkspaceBranch,
    sourceHostId,
    sourceRuntimeOwnerEnvironmentId,
    projectHostSetupOptions,
    selectedProjectHostSetupId,
    selectedRepoExecutionHostId,
    selectedEphemeralVmRecipeId,
    hasLockedPushTarget = false
  } = input
  const copyMode = Boolean(lockedWorkspaceBranch)
  const [clonedSetupKeys, setClonedSetupKeys] = useState<ReadonlySet<string>>(() => new Set())

  const isSourceHost = useCallback(
    (hostId: ExecutionHostId): boolean =>
      isLockedSourceHostTarget({
        sourceHostId,
        sourceRuntimeOwnerEnvironmentId,
        selectedTargetHostIds: [hostId]
      }),
    [sourceHostId, sourceRuntimeOwnerEnvironmentId]
  )

  const selectedSetup = projectHostSetupOptions.find(
    (option) => option.id === selectedProjectHostSetupId
  )
  const selectedSetupHostId = selectedSetup?.hostId

  const lockedTargetIsSourceHost =
    // Why: a VM recipe creates nothing on the repo's host, so the source host is not the target.
    copyMode &&
    !selectedEphemeralVmRecipeId &&
    isLockedSourceHostTarget({
      sourceHostId,
      sourceRuntimeOwnerEnvironmentId,
      selectedTargetHostIds: [selectedRepoExecutionHostId, selectedSetupHostId]
    })

  const onlySourceHostAvailable =
    copyMode &&
    projectHostSetupOptions.length > 0 &&
    projectHostSetupOptions.every((option) => isSourceHost(option.hostId))

  const recordProvisionedSetup = useCallback(
    (setupId: string, provisioning: ProjectHostSetupProvisioning): void => {
      if (provisioning !== 'cloned') {
        return
      }
      setClonedSetupKeys((current) =>
        current.has(setupId) ? current : new Set([...current, setupId])
      )
    },
    []
  )

  const selectedReadyOption = useMemo(() => {
    const option = projectHostSetupOptions.find(
      (candidate) => candidate.id === selectedProjectHostSetupId
    )
    return option?.kind === 'ready' ? option : null
  }, [projectHostSetupOptions, selectedProjectHostSetupId])

  const resolveCloneLandedCopy = useCallback(async (): Promise<Worktree | null> => {
    if (!copyMode || !lockedWorkspaceBranch || !selectedReadyOption) {
      return null
    }
    // Why not for a fork copy: the clone's checkout holds upstream's branch, not the fork's, so
    // reporting it as the copy would name a branch the copy does not have.
    if (hasLockedPushTarget) {
      return null
    }
    if (!clonedSetupKeys.has(getProjectHostSetupSelectionKey(selectedReadyOption))) {
      return null
    }
    const hostId = selectedReadyOption.hostId
    const store = useAppStore.getState()
    await store.fetchWorktrees(selectedReadyOption.repoId, { executionHostId: hostId })
    // Why the primary checkout: a fresh clone has exactly one, so it identifies the checkout this
    // flow created without comparing path spellings Windows, symlinks and WSL report differently.
    const landed = (
      selectWorktreesByRepo(useAppStore.getState())[selectedReadyOption.repoId] ?? []
    ).find(
      (worktree) =>
        worktree.isMainWorktree === true &&
        branchName(worktree.branch ?? '') === branchName(lockedWorkspaceBranch) &&
        // A twin repo id can hold another host's row, and an unstamped row is a local one.
        (worktree.hostId ?? LOCAL_EXECUTION_HOST_ID) === hostId
    )
    return landed ?? null
  }, [copyMode, clonedSetupKeys, hasLockedPushTarget, lockedWorkspaceBranch, selectedReadyOption])

  return {
    lockedTargetIsSourceHost,
    onlySourceHostAvailable,
    recordProvisionedSetup,
    resolveCloneLandedCopy,
    selectedTargetHostLabel: selectedSetup?.label ?? ''
  }
}
