import { useMemo, useState } from 'react'
import { Check, ChevronDown, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useTranslate } from '@/i18n/use-translate'
import {
  describeJiraBoardSelections,
  jiraBoardSelectionKey,
  jiraBoardSelectionsFromBoards
} from '../../../../../shared/jira/jira-board-selection'
import { useJiraBoardRuntimeSettings, useJiraBoardSearch } from '../../jira-board-search'
import type { TaskPageComposerActionsModel } from '../use-task-page-composer-actions'

/**
 * The board switcher in the Tasks source bar.
 *
 * With a curated set it lists those boards in their saved order and asks Jira for nothing. With
 * no set (sticky-all) it lists whatever the account can reach, fetched when it opens and filtered
 * by Jira's own name search — one page per site, because that is what `jira.listBoards` returns.
 */
export function TaskPageJiraBoardSwitcher({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const t = useTranslate()
  const {
    taskSource,
    jiraConnected,
    jiraSelectedBoard,
    jiraSavedBoards,
    jiraConnectedSiteIds,
    jiraSites,
    selectJiraBoard,
    settings
  } = model
  const [open, setOpen] = useState(false)
  const runtimeSettings = useJiraBoardRuntimeSettings(settings)
  // Why only when open: a device that keeps a curated set must not query Jira on every render.
  const search = useJiraBoardSearch({
    runtimeSettings,
    siteId: 'all',
    enabled: open && jiraSavedBoards === null
  })
  const options = useMemo(() => {
    const saved = jiraSavedBoards ?? jiraBoardSelectionsFromBoards(search.boards)
    // Why keep the open board in the list: under sticky-all the fetched page may not contain it,
    // and a picker that hides the current value reads as if nothing is selected.
    const currentKey = jiraSelectedBoard ? jiraBoardSelectionKey(jiraSelectedBoard) : null
    const selections =
      jiraSelectedBoard &&
      currentKey &&
      !saved.some((selection) => jiraBoardSelectionKey(selection) === currentKey)
        ? [jiraSelectedBoard, ...saved]
        : saved
    return describeJiraBoardSelections({
      selections,
      sites: jiraSites,
      connectedSiteIds: jiraConnectedSiteIds
    })
  }, [jiraConnectedSiteIds, jiraSavedBoards, jiraSelectedBoard, jiraSites, search.boards])
  const selectedKey = jiraSelectedBoard ? jiraBoardSelectionKey(jiraSelectedBoard) : null
  const selectedOption = options.find(
    (option) => jiraBoardSelectionKey(option.selection) === selectedKey
  )
  const currentLabel =
    selectedOption?.label ??
    (jiraSelectedBoard ? jiraSelectedBoard.name?.trim() || jiraSelectedBoard.boardId : null)
  const currentSiteLabel = selectedOption?.siteLabel ?? null
  if (taskSource !== 'jira' || !jiraConnected) {
    return null
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={t('jira.board.switcher', 'Jira board')}
          className="w-[200px] justify-between"
        >
          <span className="min-w-0 truncate">
            {currentLabel ? (
              <>
                {currentLabel}
                {currentSiteLabel && jiraSites.length > 1 ? (
                  <span className="text-muted-foreground"> · {currentSiteLabel}</span>
                ) : null}
              </>
            ) : (
              <span className="text-muted-foreground">
                {t('jira.board.chooseBoard', 'Choose board')}
              </span>
            )}
          </span>
          <ChevronDown className="size-3.5 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <Command shouldFilter={jiraSavedBoards === null}>
          <CommandInput
            placeholder={t('jira.board.searchBoards', 'Search boards...')}
            onValueChange={search.setQuery}
          />
          <CommandList>
            {search.loading ? (
              <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                <LoaderCircle className="size-3.5 animate-spin" />
                {t('jira.board.loadingBoards', 'Loading boards...')}
              </div>
            ) : null}
            <CommandEmpty>
              {search.error ? null : t('jira.board.noBoards', 'No boards match this search.')}
            </CommandEmpty>
            {search.error ? (
              <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs text-destructive">
                <span className="min-w-0">{search.error}</span>
                <Button type="button" variant="outline" size="xs" onClick={search.retry}>
                  {t('auto.components.settings.JiraBoardSettings.retry', 'Retry')}
                </Button>
              </div>
            ) : null}
            {options.map((option) => {
              const key = jiraBoardSelectionKey(option.selection)
              return (
                <CommandItem
                  key={key}
                  value={`${option.label} ${option.siteLabel ?? ''}`}
                  disabled={option.stale}
                  data-current={key === selectedKey ? 'true' : undefined}
                  onSelect={() => {
                    selectJiraBoard(option.selection)
                    setOpen(false)
                  }}
                >
                  <Check
                    className={
                      key === selectedKey
                        ? 'size-3.5 text-foreground'
                        : 'size-3.5 text-foreground opacity-0'
                    }
                  />
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  <span className="shrink-0 text-2xs text-muted-foreground">
                    {option.stale
                      ? t('jira.settings.siteNotConnected', 'Site not connected')
                      : option.siteLabel}
                  </span>
                </CommandItem>
              )
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
