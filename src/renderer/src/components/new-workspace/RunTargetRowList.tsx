import React from 'react'
import type {
  NeedsSetupProjectHostOption,
  ReadyProjectHostSetupOption
} from '@/lib/project-host-setup-options'
import type { RepoKind } from '../../../../shared/repo-types'
import { useTranslate } from '@/i18n/use-translate'
import { HostRowIcon, RunTargetRow } from './RunTargetComboboxRow'
import {
  CloneProgressLabel,
  ConnectHostButton,
  NeedsSetupHostIcon,
  RowTextAction
} from './RunTargetRowActions'
import { RecipesSubmenuRow } from './RunTargetSubmenus'
import {
  getRunTargetCloneAvailability,
  resolveRunTargetRowAction
} from './run-target-clone-availability'
import type { EphemeralVmRecipeOption, RunTargetRowModel } from './run-target-options'
import type { RunTargetCloneStatus } from './use-run-target-auto-clone'

/** The scrolling rows of the run-target picker; "Add host" is pinned outside this list. */
export default function RunTargetRowList({
  rows,
  armedKey,
  listId,
  selectedHost,
  selectedRecipeId,
  matchedRecipes,
  recipesOpen,
  connectingHostIds,
  canConnect,
  projectKind,
  cloneUrl,
  cloneStatus,
  onArm,
  onRecipesOpenChange,
  onSelectHost,
  onSelectRecipe,
  onConnectHost,
  onStartClone,
  onUseExistingFolder,
  onRetryClone,
  onCloneAs
}: {
  rows: readonly RunTargetRowModel[]
  armedKey: string | null
  listId: string
  /** The committed host, or null while a recipe holds the selection. */
  selectedHost: ReadyProjectHostSetupOption | null
  selectedRecipeId: string | null
  matchedRecipes: readonly EphemeralVmRecipeOption[]
  recipesOpen: boolean
  connectingHostIds: ReadonlySet<string>
  canConnect: boolean
  projectKind: RepoKind
  cloneUrl: string
  cloneStatus: RunTargetCloneStatus
  /** Arms a row and opens the submenu that row owns, if any. */
  onArm: (key: string, submenu: 'recipes' | null) => void
  onRecipesOpenChange: (open: boolean) => void
  onSelectHost: (option: ReadyProjectHostSetupOption) => void
  onSelectRecipe: (recipeId: string) => void
  onConnectHost: (option: NeedsSetupProjectHostOption) => void
  onStartClone: (option: NeedsSetupProjectHostOption) => void
  onUseExistingFolder: (option: NeedsSetupProjectHostOption, initialPath?: string) => void
  onRetryClone: () => void
  onCloneAs: (folderName: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <>
      {rows.map((row) => {
        if (row.kind === 'add-host') {
          return null
        }
        const isArmed = armedKey === row.key
        const optionId = isArmed ? `${listId}-armed` : undefined
        if (row.kind === 'ready') {
          return (
            <RunTargetRow
              key={row.key}
              icon={<HostRowIcon hostId={row.option.hostId} />}
              label={row.option.label}
              detail={row.option.path}
              armed={isArmed}
              current={row.option === selectedHost}
              optionId={optionId}
              onArm={() => onArm(row.key, null)}
              onCommit={() => onSelectHost(row.option)}
            />
          )
        }
        if (row.kind === 'needs-setup') {
          const connecting = connectingHostIds.has(row.option.hostId)
          const hasConnect = Boolean(row.option.connectAction && canConnect)
          const availability = getRunTargetCloneAvailability(
            row.option,
            { projectKind, cloneUrl },
            t
          )
          const status =
            cloneStatus.kind !== 'idle' && cloneStatus.target.hostId === row.option.hostId
              ? cloneStatus
              : null
          const cloning = status?.kind === 'resolving' || status?.kind === 'cloning'
          const commitRow = (): void => {
            const action = resolveRunTargetRowAction(availability, status?.kind ?? 'idle')
            if (action === 'start-clone') {
              onStartClone(row.option)
              return
            }
            if (action === 'retry-clone') {
              onRetryClone()
              return
            }
            if (action === 'use-existing-folder') {
              onUseExistingFolder(row.option)
            }
          }
          const detail =
            status?.kind === 'failed'
              ? status.message
              : status?.kind === 'folder-taken'
                ? t(
                    'auto.components.NewWorkspaceComposerCard.cloneFolderTaken',
                    '{{folder}} already exists on {{host}}.',
                    { folder: status.folderName, host: row.option.label }
                  )
                : availability.kind === 'existing-folder-only'
                  ? availability.reason
                  : hasConnect || cloning
                    ? ''
                    : row.option.detail
          const trailing = hasConnect ? (
            <ConnectHostButton
              connecting={connecting}
              onConnect={() => onConnectHost(row.option)}
            />
          ) : cloning ? (
            <CloneProgressLabel />
          ) : availability.kind === 'existing-folder-only' ? (
            <RowTextAction
              label={t(
                'auto.components.NewWorkspaceComposerCard.useExistingFolder',
                'Use existing folder'
              )}
              ariaLabel={t(
                'auto.components.NewWorkspaceComposerCard.useExistingFolderOnHost',
                'Use an existing folder on {{host}}',
                { host: row.option.label }
              )}
              onClick={() => onUseExistingFolder(row.option)}
            />
          ) : status?.kind === 'failed' ? (
            <span className="ml-1 flex shrink-0 items-center self-center">
              <RowTextAction
                label={t('auto.components.NewWorkspaceComposerCard.retryClone', 'Retry')}
                ariaLabel={t(
                  'auto.components.NewWorkspaceComposerCard.retryCloneOnHost',
                  'Retry cloning onto {{host}}',
                  { host: row.option.label }
                )}
                onClick={onRetryClone}
              />
              <RowTextAction
                label={t(
                  'auto.components.NewWorkspaceComposerCard.useExistingFolder',
                  'Use existing folder'
                )}
                ariaLabel={t(
                  'auto.components.NewWorkspaceComposerCard.useExistingFolderOnHost',
                  'Use an existing folder on {{host}}',
                  { host: row.option.label }
                )}
                onClick={() => onUseExistingFolder(row.option)}
              />
            </span>
          ) : status?.kind === 'folder-taken' ? (
            <RowTextAction
              label={t(
                'auto.components.NewWorkspaceComposerCard.cloneAsSuggestion',
                'Clone as {{name}}',
                { name: status.suggestion }
              )}
              onClick={() => onCloneAs(status.suggestion)}
            />
          ) : undefined
          return (
            <RunTargetRow
              key={row.key}
              icon={
                <NeedsSetupHostIcon
                  hostId={row.option.hostId}
                  connecting={connecting || Boolean(cloning)}
                  attention={row.option.attention}
                />
              }
              label={row.option.label}
              // fork-comment-ok: inline Connect/clone state already provides the next step.
              detail={detail}
              armed={isArmed}
              current={false}
              dimmed
              optionId={optionId}
              onArm={() => onArm(row.key, null)}
              onCommit={commitRow}
              trailing={trailing}
            />
          )
        }
        return (
          <RecipesSubmenuRow
            key={row.key}
            open={recipesOpen}
            onOpenChange={onRecipesOpenChange}
            armed={isArmed}
            optionId={optionId}
            recipes={matchedRecipes}
            selectedRecipeId={selectedRecipeId}
            onArm={() => onArm(row.key, 'recipes')}
            onSelectRecipe={onSelectRecipe}
          />
        )
      })}
    </>
  )
}
