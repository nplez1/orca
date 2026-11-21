import { useState } from 'react'
import {
  getProjectHostSetupSelectionKey,
  type NeedsSetupProjectHostOption,
  type ProjectHostSetupOption
} from '@/lib/workspace/creation/project-host-setup-options'
import { useTranslate } from '@/i18n/use-translate'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import type { RepoKind } from '../../../../../shared/repository/repo-types'
import RunTargetCombobox from './RunTargetCombobox'
import { ConnectHostButton, NeedsSetupHostIcon } from './RunTargetRowActions'
import {
  getRunTargetCloneAvailability,
  resolveRunTargetRowAction
} from '../run-target-clone-availability'
import type { RunTargetAutoClone } from '../use-run-target-auto-clone'
import type { EphemeralVmRecipeOption, RunTargetHostOption } from './run-target-options'

export default function WorkspaceRunTargetCombobox({
  hostOptions,
  hostValue,
  hostExecutionHostId,
  onHostChange,
  onConnectHost,
  onSetLocation,
  projectKind = 'git',
  cloneUrl = '',
  clone = null,
  onStartClone,
  onUseExistingFolder,
  onRecipeChange,
  ...picker
}: {
  hostOptions: readonly ProjectHostSetupOption[]
  hostValue: string | null
  hostExecutionHostId?: ExecutionHostId | null
  onHostChange?: (setupId: string) => void
  onConnectHost?: (option: NeedsSetupProjectHostOption) => Promise<void> | void
  onSetLocation?: (option: NeedsSetupProjectHostOption) => void
  projectKind?: RepoKind
  cloneUrl?: string
  clone?: RunTargetAutoClone | null
  onStartClone?: (option: NeedsSetupProjectHostOption) => void
  onUseExistingFolder?: (option: NeedsSetupProjectHostOption) => void
  recipes: readonly EphemeralVmRecipeOption[]
  recipeValue: string | null
  onRecipeChange?: (recipeId: string | null) => void
  onAddRemoteServer?: () => void
  onAddSshHost?: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [connectingHosts, setConnectingHosts] = useState<ReadonlySet<ExecutionHostId>>(
    () => new Set()
  )
  const isSelected = (option: { id: string; hostId: ExecutionHostId }): boolean =>
    option.id === hostValue && (!hostExecutionHostId || option.hostId === hostExecutionHostId)
  const ready = hostOptions.filter((option) => option.kind === 'ready')
  const selected =
    ready.find(isSelected) ?? ready.find((option) => option.aliasSetups?.some(isSelected))

  const connectHost = async (option: NeedsSetupProjectHostOption): Promise<void> => {
    if (!onConnectHost || connectingHosts.has(option.hostId)) {
      return
    }
    setConnectingHosts((current) => new Set(current).add(option.hostId))
    await Promise.resolve()
      .then(() => onConnectHost(option))
      .finally(() => {
        setConnectingHosts((current) => {
          const next = new Set(current)
          next.delete(option.hostId)
          return next
        })
      })
  }

  const clearPendingClone = clone?.clear
  // fork-comment-ok: a ready host or a recipe replaces the pending clone, so it stops blocking Create
  // and a clone that finishes later cannot retarget the selection the user just made.
  const selectHost = (id: string): void => {
    onHostChange?.(id)
    onRecipeChange?.(null)
    clearPendingClone?.()
  }
  const selectRecipe = (recipeId: string | null): void => {
    onRecipeChange?.(recipeId)
    clearPendingClone?.()
  }

  const options = hostOptions.map((option): RunTargetHostOption => {
    const id = getProjectHostSetupSelectionKey(option)
    const { hostId, label } = option
    if (option.kind === 'ready') {
      return {
        id,
        hostId,
        label,
        detail: option.path,
        searchText: option.detail,
        available: true,
        onSelect: () => selectHost(id)
      }
    }
    const connecting = connectingHosts.has(hostId)
    const connect = Boolean(option.connectAction && onConnectHost)
    // The composer's "use an existing folder" IS the set-location dialog, so either callback can
    // carry the row's commit-to-a-folder action.
    const chooseFolder = option.canSetLocation ? (onSetLocation ?? onUseExistingFolder) : undefined
    const cloneStatus =
      clone && clone.status.kind !== 'idle' && clone.status.target.hostId === hostId
        ? clone.status
        : null
    const availability = getRunTargetCloneAvailability(option, { projectKind, cloneUrl }, t)
    // Why decided once: a click and Enter must not disagree about what choosing this host does.
    const action = resolveRunTargetRowAction(availability, cloneStatus?.kind ?? 'idle')
    const selectRow = (): void => {
      if (action === 'start-clone' && onStartClone) {
        onStartClone(option)
        return
      }
      if (action === 'retry-clone' && clone) {
        clone.retry()
        return
      }
      if (action === 'use-existing-folder') {
        chooseFolder?.(option)
      }
    }
    // fork-comment-ok: 'none' means refused or already cloning; letting the row through would re-enter
    // provisioning and race the clone resolveRunTargetRowAction is protecting.
    const canSelect =
      (action === 'start-clone' && onStartClone !== undefined) ||
      (action === 'retry-clone' && clone !== null) ||
      (action === 'use-existing-folder' && chooseFolder !== undefined)
    return {
      id,
      hostId,
      label,
      // A row that cannot clone says why, rather than looking like it silently declined.
      detail:
        availability.kind === 'existing-folder-only'
          ? availability.reason
          : connect || canSelect
            ? ''
            : option.detail,
      searchText: option.detail,
      available: false,
      icon: (
        <NeedsSetupHostIcon hostId={hostId} connecting={connecting} attention={option.attention} />
      ),
      onSelect: canSelect ? selectRow : undefined,
      // Why no set-location affordance: the fork's rows commit on choose, so a trailing "set location"
      // button would offer the same action twice. Only Connect is a separate action.
      trailing: connect
        ? () => (
            <ConnectHostButton connecting={connecting} onConnect={() => void connectHost(option)} />
          )
        : undefined
    }
  })

  return (
    <RunTargetCombobox
      {...picker}
      onRecipeChange={selectRecipe}
      hostOptions={options}
      selectedHostId={selected ? getProjectHostSetupSelectionKey(selected) : null}
    />
  )
}
