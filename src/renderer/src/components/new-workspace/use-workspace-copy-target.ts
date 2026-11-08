import { useCallback, useMemo, useState } from 'react'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { Worktree } from '../../../../shared/worktree/types'
import { branchName } from '@/lib/git-utils'
import {
  getProjectHostSetupSelectionKey,
  type ProjectHostSetupOption
} from '@/lib/project-host-setup-options'
import { useAppStore } from '@/store'
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
    selectedEphemeralVmRecipeId
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
    if (!clonedSetupKeys.has(getProjectHostSetupSelectionKey(selectedReadyOption))) {
      return null
    }
    const store = useAppStore.getState()
    await store.fetchWorktrees(selectedReadyOption.repoId)
    // Why the path: a clone's destination is that repo's primary checkout, so it identifies the
    // checkout this flow created without guessing which host a twin repo id belongs to.
    const landed = (useAppStore.getState().worktreesByRepo[selectedReadyOption.repoId] ?? []).find(
      (worktree) =>
        worktree.path === selectedReadyOption.path &&
        branchName(worktree.branch ?? '') === branchName(lockedWorkspaceBranch)
    )
    return landed ?? null
  }, [copyMode, clonedSetupKeys, lockedWorkspaceBranch, selectedReadyOption])

  return {
    lockedTargetIsSourceHost,
    onlySourceHostAvailable,
    recordProvisionedSetup,
    resolveCloneLandedCopy,
    selectedTargetHostLabel: selectedSetup?.label ?? ''
  }
}
