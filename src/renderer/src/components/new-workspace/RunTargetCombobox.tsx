import React, { useCallback, useMemo, useState } from 'react'
import { Popover, PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { useTranslate } from '@/i18n/use-translate'
import {
  getProjectHostSetupSelectionKey,
  type NeedsSetupProjectHostOption,
  type ProjectHostSetupOption,
  type ReadyProjectHostSetupOption
} from '@/lib/project-host-setup-options'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { RepoKind } from '../../../../shared/repo-types'
import { isWithinComboboxRoot, useTypeAheadCombobox } from './use-type-ahead-combobox'
import { COMBOBOX_POPOVER_SURFACE } from './type-ahead-combobox-styles'
import {
  buildRunTargetRows,
  getEphemeralVmLabel,
  getRecipeDetail,
  RUN_TARGET_ADD_HOST_KEY,
  type EphemeralVmRecipeOption
} from './run-target-options'
import { AddHostSubmenuRow } from './RunTargetSubmenus'
import RunTargetRowList from './RunTargetRowList'
import RunTargetField from './RunTargetField'
import {
  getRunTargetCloneAvailability,
  resolveRunTargetRowAction
} from './run-target-clone-availability'
import type { RunTargetAutoClone } from './use-run-target-auto-clone'
import { HostListOverflowNote } from '@/components/host-picker/HostListOverflowNote'

type RunTargetComboboxProps = {
  hostOptions: readonly ProjectHostSetupOption[]
  hostValue: string | null
  hostExecutionHostId?: ExecutionHostId | null
  onHostChange?: (setupId: string) => void
  recipes: EphemeralVmRecipeOption[]
  recipeValue: string | null
  onRecipeChange?: (recipeId: string | null) => void
  onAddRemoteServer?: () => void
  onAddSshHost?: () => void
  onConnectHost?: (option: NeedsSetupProjectHostOption) => Promise<void> | void
  projectKind: RepoKind
  cloneUrl: string
  clone: RunTargetAutoClone | null
  onStartClone?: (option: NeedsSetupProjectHostOption) => void
  onUseExistingFolder?: (option: NeedsSetupProjectHostOption) => void
}

const ROOT_ATTRIBUTE = 'data-run-target-combobox-root'

/** Match project-picker navigation; Connect must not select its host, and recipe/Add host rows open nested lists. */
export default function RunTargetCombobox({
  hostOptions,
  hostValue,
  hostExecutionHostId,
  onHostChange,
  recipes,
  recipeValue,
  onRecipeChange,
  onAddRemoteServer,
  onAddSshHost,
  onConnectHost,
  projectKind,
  cloneUrl,
  clone = null,
  onStartClone,
  onUseExistingFolder
}: RunTargetComboboxProps): React.JSX.Element {
  const t = useTranslate()
  const [submenu, setSubmenu] = useState<'recipes' | 'add-host' | null>(null)
  // Track in-flight connects per host so one stalling connect never blocks the others.
  const [connectingHostIds, setConnectingHostIds] = useState<ReadonlySet<string>>(() => new Set())

  const hasAddHost = Boolean(onAddSshHost || onAddRemoteServer)
  const deriveRowKeys = useCallback(
    (query: string): string[] =>
      buildRunTargetRows({ hostOptions, recipes, query, hasAddHost }).rows.map((row) => row.key),
    [hasAddHost, hostOptions, recipes]
  )
  const combobox = useTypeAheadCombobox(deriveRowKeys)
  const { query, setQuery, open, setOpen, armedKey, arm, moveArm, inputRef, listId, setListNode } =
    combobox

  const { rows, matchedRecipes, hiddenHostCount } = useMemo(
    () => buildRunTargetRows({ hostOptions, recipes, query, hasAddHost }),
    [hasAddHost, hostOptions, query, recipes]
  )
  const readyHostOptions = useMemo(
    () => hostOptions.filter((option) => option.kind === 'ready'),
    [hostOptions]
  )
  const isSelected = (candidate: { id: string; hostId: string }): boolean =>
    candidate.id === hostValue && (!hostExecutionHostId || candidate.hostId === hostExecutionHostId)
  const selectedHost =
    readyHostOptions.find(isSelected) ??
    // Why: a selection on a merged machine's other id still belongs to that machine's one row.
    readyHostOptions.find((option) => option.aliasSetups?.some(isSelected)) ??
    // An unlisted target (e.g. a per-workspace VM) shows "Choose target", never another host's name (#38669).
    null
  const selectedRecipe = recipes.find((recipe) => recipe.id === recipeValue) ?? null
  // fork-comment-ok: the pending clone is the only source for the field's value until a setup exists.
  const pendingClone = clone && clone.status.kind !== 'idle' ? clone.status.target : null
  const armedRow = rows.find((row) => row.key === armedKey) ?? rows[0] ?? null
  const committed =
    query.length === 0 &&
    (selectedRecipe !== null || selectedHost !== null || pendingClone !== null)

  // Closing also drops any open submenu, which the shared hook doesn't know about.
  const close = useCallback((): void => {
    combobox.close()
    setSubmenu(null)
  }, [combobox])

  const clearPendingClone = clone?.clear
  const selectHost = useCallback(
    (option: ReadyProjectHostSetupOption): void => {
      onHostChange?.(getProjectHostSetupSelectionKey(option))
      onRecipeChange?.(null)
      clearPendingClone?.()
      close()
    },
    [clearPendingClone, close, onHostChange, onRecipeChange]
  )

  const selectRecipe = useCallback(
    (recipeId: string): void => {
      onRecipeChange?.(recipeId)
      clearPendingClone?.()
      close()
    },
    [clearPendingClone, close, onRecipeChange]
  )

  const connectHost = useCallback(
    async (option: NeedsSetupProjectHostOption): Promise<void> => {
      if (!option.connectAction || !onConnectHost || connectingHostIds.has(option.hostId)) {
        return
      }
      setConnectingHostIds((current) => new Set(current).add(option.hostId))
      try {
        await onConnectHost(option)
      } finally {
        setConnectingHostIds((current) => {
          if (!current.has(option.hostId)) {
            return current
          }
          const next = new Set(current)
          next.delete(option.hostId)
          return next
        })
      }
    },
    [connectingHostIds, onConnectHost]
  )

  const startClone = useCallback(
    (option: NeedsSetupProjectHostOption): void => {
      if (!onStartClone) {
        return
      }
      close()
      onStartClone(option)
    },
    [close, onStartClone]
  )

  const openExistingFolder = useCallback(
    (option: NeedsSetupProjectHostOption): void => {
      if (!onUseExistingFolder) {
        return
      }
      close()
      onUseExistingFolder(option)
    },
    [close, onUseExistingFolder]
  )

  const activate = useCallback(
    (key: string | null): void => {
      const row = rows.find((candidate) => candidate.key === key)
      if (!row) {
        return
      }
      if (row.kind === 'ready') {
        selectHost(row.option)
        return
      }
      if (row.kind === 'needs-setup') {
        // fork-comment-ok: a refused host must keep the reason its row shows, not gain a clone.
        const availability = getRunTargetCloneAvailability(row.option, { projectKind, cloneUrl }, t)
        const rowStatus =
          clone && clone.status.kind !== 'idle' && clone.status.target.hostId === row.option.hostId
            ? clone.status
            : null
        // Same routing as the row's own click, so Enter and a click can never disagree.
        const action = resolveRunTargetRowAction(availability, rowStatus?.kind ?? 'idle')
        if (action === 'start-clone') {
          startClone(row.option)
        } else if (action === 'retry-clone') {
          close()
          clone?.retry()
        } else if (action === 'use-existing-folder') {
          openExistingFolder(row.option)
        }
        return
      }
      setSubmenu(row.kind === 'recipes' ? 'recipes' : 'add-host')
    },
    [clone, cloneUrl, close, openExistingFolder, projectKind, rows, selectHost, startClone, t]
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>): void => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setOpen(true)
        moveArm(event.key === 'ArrowDown' ? 1 : -1)
        setSubmenu(null)
        return
      }
      if ((event.key === 'Enter' || event.key === 'ArrowRight') && open) {
        event.preventDefault()
        activate(armedRow?.key ?? null)
        return
      }
      if (event.key === 'Escape' && (open || query.length > 0)) {
        event.preventDefault()
        event.stopPropagation()
        if (submenu !== null) {
          setSubmenu(null)
          return
        }
        close()
      }
    },
    [activate, armedRow, close, moveArm, open, query, setOpen, submenu]
  )

  const handleOpenChange = useCallback(
    (next: boolean): void => {
      if (next) {
        setOpen(true)
        return
      }
      close()
    },
    [close, setOpen]
  )

  const fieldLabel = selectedRecipe
    ? `${getEphemeralVmLabel(t)} / ${selectedRecipe.name}`
    : (pendingClone?.label ?? selectedHost?.label ?? '')
  const fieldDetail = selectedRecipe
    ? getRecipeDetail(selectedRecipe, t)
    : pendingClone
      ? clone?.status.kind === 'failed'
        ? clone.status.message
        : clone?.status.kind === 'folder-taken'
          ? t(
              'auto.components.NewWorkspaceComposerCard.cloneFolderTaken',
              '{{folder}} already exists on {{host}}.',
              { folder: clone.status.folderName, host: pendingClone.label }
            )
          : t(
              'auto.components.NewWorkspaceComposerCard.cloningOntoHost',
              'Cloning onto {{host}}…',
              { host: pendingClone.label }
            )
      : (selectedHost?.path ?? '')

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <RunTargetField
        query={query}
        onQueryChange={(value) => {
          setQuery(value)
          setOpen(true)
          setSubmenu(null)
        }}
        open={open}
        onOpenRequest={() => setOpen(true)}
        onToggle={() => setOpen(!open)}
        committed={committed}
        isRecipe={selectedRecipe !== null}
        hostId={pendingClone?.hostId ?? selectedHost?.hostId ?? null}
        label={fieldLabel}
        detail={fieldDetail}
        listId={listId}
        hasArmedRow={armedRow !== null}
        inputRef={inputRef}
        onKeyDown={handleKeyDown}
      />
      <PopoverContent
        align="start"
        sideOffset={4}
        className={cn(
          'flex w-[var(--radix-popover-trigger-width)] min-w-[18rem] flex-col p-0',
          COMBOBOX_POPOVER_SURFACE
        )}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        // The search anchor is outside Radix content; preserve interactions inside this control.
        onFocusOutside={(event) => {
          if (isWithinComboboxRoot(event.target, ROOT_ATTRIBUTE)) {
            event.preventDefault()
          }
        }}
        onInteractOutside={(event) => {
          if (isWithinComboboxRoot(event.target, ROOT_ATTRIBUTE)) {
            event.preventDefault()
          }
        }}
      >
        <div
          id={listId}
          role="listbox"
          aria-label={t('auto.components.new.workspace.RunTargetCombobox.listLabel', 'Run targets')}
          className="flex min-h-0 flex-col"
        >
          <div
            ref={setListNode}
            role="presentation"
            className="max-h-72 min-h-0 flex-1 overflow-y-auto p-1 scrollbar-sleek"
          >
            {rows.filter((row) => row.kind !== 'add-host').length === 0 ? (
              <p className="flex h-8 items-center justify-center px-2 text-sm text-muted-foreground">
                {t(
                  'auto.components.NewWorkspaceComposerCard.noRunTargets',
                  'No run targets are ready for this project.'
                )}
              </p>
            ) : null}
            <RunTargetRowList
              rows={rows}
              armedKey={armedRow?.key ?? null}
              listId={listId}
              selectedHost={selectedRecipe === null ? selectedHost : null}
              selectedRecipeId={selectedRecipe?.id ?? null}
              matchedRecipes={matchedRecipes}
              recipesOpen={submenu === 'recipes'}
              connectingHostIds={connectingHostIds}
              canConnect={Boolean(onConnectHost)}
              projectKind={projectKind}
              cloneUrl={cloneUrl}
              cloneStatus={clone?.status ?? { kind: 'idle' }}
              onArm={(key, nextSubmenu) => {
                arm(key)
                setSubmenu(nextSubmenu)
              }}
              onRecipesOpenChange={(next) => setSubmenu(next ? 'recipes' : null)}
              onSelectHost={selectHost}
              onSelectRecipe={selectRecipe}
              onConnectHost={(option) => void connectHost(option)}
              onStartClone={startClone}
              onUseExistingFolder={openExistingFolder}
              onRetryClone={() => clone?.retry()}
              onCloneAs={(folderName) => clone?.cloneAs(folderName)}
            />
          </div>
          <HostListOverflowNote hiddenCount={hiddenHostCount} />
          {hasAddHost ? (
            <AddHostSubmenuRow
              open={submenu === 'add-host'}
              onOpenChange={(next) => setSubmenu(next ? 'add-host' : null)}
              armed={armedRow?.key === RUN_TARGET_ADD_HOST_KEY}
              optionId={armedRow?.key === RUN_TARGET_ADD_HOST_KEY ? `${listId}-armed` : undefined}
              onArm={() => {
                arm(RUN_TARGET_ADD_HOST_KEY)
                setSubmenu('add-host')
              }}
              {...(onAddSshHost
                ? {
                    onAddSshHost: () => {
                      close()
                      onAddSshHost()
                    }
                  }
                : {})}
              {...(onAddRemoteServer
                ? {
                    onAddRemoteServer: () => {
                      close()
                      onAddRemoteServer()
                    }
                  }
                : {})}
            />
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}
