import { useEffect, useMemo, useRef } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { toast } from 'sonner'
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import { runtimeHostIdFromEnvironmentId } from '../../../../shared/work-items/task-source-context'
import type { JiraBoardSelection } from '../../../../shared/jira/jira-types'
import {
  addJiraBoardSelection,
  connectedJiraSiteIds,
  describeJiraBoardSelections,
  effectiveJiraBoardSet,
  jiraBoardSelectionKey,
  jiraBoardSettingsWrite,
  moveJiraBoardSelection,
  normalizeJiraBoardSelection,
  removeJiraBoardSelection
} from '../../../../shared/jira/jira-board-selection'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { useJiraBoardRuntimeSettingsForHost, useJiraBoardSearch } from '../jira-board-search'
import { SearchableSetting } from './section-layout/SearchableSetting'
import { boardOptionValue, buildJiraBoardOptions } from './jira-settings-combobox-options'
import { SettingsCombobox } from './SettingsCombobox'
import { getTasksPaneSearchKeywords } from './tasks/tasks-search'

type JiraBoardSettingsProps = {
  settings: GlobalSettings
  /** The throwing variant: a board that does not persist has to say so, not log and revert. */
  updateSettingsOrThrow: (updates: Partial<GlobalSettings>) => Promise<void>
}

export function JiraBoardSettings({
  settings,
  updateSettingsOrThrow
}: JiraBoardSettingsProps): React.JSX.Element {
  const t = useTranslate()
  const jiraStatus = useAppStore((state) => state.jiraStatus)
  const checkJiraConnection = useAppStore((state) => state.checkJiraConnection)
  useEffect(() => {
    void checkJiraConnection()
  }, [checkJiraConnection])
  // Why the focused host: this pane edits that host's own settings, so it owns the boards listed
  // here (same rule as the settings host scope). The Tasks switcher routes by its page's host.
  const boardOwnerHostId = runtimeHostIdFromEnvironmentId(settings.activeRuntimeEnvironmentId)
  const runtimeSettings = useJiraBoardRuntimeSettingsForHost(boardOwnerHostId)
  // Why every site: a set spans sites, so the picker must find a board on any connected account.
  const search = useJiraBoardSearch({ runtimeSettings, siteId: 'all' })
  const savedBoards = useMemo(() => effectiveJiraBoardSet(settings), [settings])
  const connectedSiteIds = useMemo(() => connectedJiraSiteIds(jiraStatus, true), [jiraStatus])
  const savedKeys = useMemo(
    () => new Set((savedBoards ?? []).map((selection) => jiraBoardSelectionKey(selection))),
    [savedBoards]
  )
  // Why: a board renamed in Jira still resolves by id, so the list shows the live name and the
  // next write stores it; nothing is deleted on a name mismatch.
  const liveNames = useMemo(
    () =>
      new Map(
        search.boards.map((board) => [
          boardOptionValue({ siteId: board.siteId, id: board.id }),
          board.name
        ])
      ),
    [search.boards]
  )
  const boardOptions = useMemo(
    () =>
      buildJiraBoardOptions(
        search.boards.filter(
          (board) => !savedKeys.has(boardOptionValue({ siteId: board.siteId, id: board.id }))
        ),
        null,
        ''
      ),
    [savedKeys, search.boards]
  )
  // Why one description pass: the rows and the switcher must agree on names and on what counts
  // as unreachable, and deriving it twice is how the two drift apart.
  const savedRows = useMemo(
    () =>
      describeJiraBoardSelections({
        selections: savedBoards ?? [],
        sites: jiraStatus.sites ?? [],
        connectedSiteIds
      }).map((option) => ({
        ...option,
        label:
          liveNames.get(
            boardOptionValue({ siteId: option.selection.siteId, id: option.selection.boardId })
          ) ?? option.label
      })),
    [connectedSiteIds, jiraStatus.sites, liveNames, savedBoards]
  )
  // Why a ref: the store mirrors a write only once it lands, so two quick edits both computed
  // from the same stale set, and the second silently undid the first.
  const pendingSetRef = useRef<JiraBoardSelection[] | null | undefined>(undefined)
  useEffect(() => {
    pendingSetRef.current = undefined
  }, [savedBoards])
  // Why: the store only mirrors a settings write once it lands, so a rejected write leaves the
  // list on the old set — and without this the user never learns the change did not stick.
  const saveSet = (next: JiraBoardSelection[] | null): void => {
    const refreshed = next?.map((selection) => {
      const liveName = liveNames.get(
        boardOptionValue({ siteId: selection.siteId, id: selection.boardId })
      )
      return liveName && liveName !== selection.name ? { ...selection, name: liveName } : selection
    })
    pendingSetRef.current = refreshed ?? null
    void updateSettingsOrThrow(jiraBoardSettingsWrite(refreshed ?? null)).catch(() => {
      pendingSetRef.current = undefined
      toast.error(t('sessionHistory.settings.saveError', 'Could not save. Try again.'))
    })
  }
  const currentSet = (): JiraBoardSelection[] | null =>
    pendingSetRef.current === undefined ? savedBoards : pendingSetRef.current
  const addBoard = (value: string): void => {
    const board = search.boards.find((candidate) => boardOptionValue(candidate) === value)
    const selection = normalizeJiraBoardSelection(
      board ? { boardId: board.id, siteId: board.siteId, name: board.name } : null
    )
    if (selection) {
      saveSet(addJiraBoardSelection(currentSet(), selection))
    }
  }

  return (
    <section className="space-y-3" data-settings-section="tasks-jira-board">
      <SearchableSetting
        title={t('auto.components.settings.JiraBoardSettings.title', 'Jira boards')}
        description={t(
          'auto.components.settings.JiraBoardSettings.description',
          'Save the boards you work across, then switch between them in Tasks.'
        )}
        keywords={getTasksPaneSearchKeywords()}
      >
        <div className="max-w-md space-y-3">
          {savedBoards ? (
            <ul className="space-y-1" aria-label={t('jira.settings.savedBoards', 'Saved boards')}>
              {savedRows.map((row, index) => {
                const key = jiraBoardSelectionKey(row.selection)
                return (
                  <li
                    key={key}
                    className="flex items-center gap-1 rounded-md border border-border/50 bg-muted/30 py-1 pl-2 pr-1 text-xs"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {row.label}
                      {row.siteLabel ? (
                        <span className="text-muted-foreground"> · {row.siteLabel}</span>
                      ) : null}
                    </span>
                    {row.stale ? (
                      <span className="shrink-0 text-muted-foreground">
                        {t('jira.settings.siteNotConnected', 'Site not connected')}
                      </span>
                    ) : null}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('jira.settings.moveBoardUp', 'Move {{name}} up', {
                        name: row.label
                      })}
                      disabled={index === 0}
                      onClick={() => saveSet(moveJiraBoardSelection(currentSet() ?? [], key, -1))}
                    >
                      <ChevronUp />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('jira.settings.moveBoardDown', 'Move {{name}} down', {
                        name: row.label
                      })}
                      disabled={index === savedRows.length - 1}
                      onClick={() => saveSet(moveJiraBoardSelection(currentSet() ?? [], key, 1))}
                    >
                      <ChevronDown />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('jira.settings.removeBoard', 'Remove {{name}}', {
                        name: row.label
                      })}
                      onClick={() => {
                        const next = removeJiraBoardSelection(currentSet() ?? [], key)
                        // Why null and not an empty list: an empty set offers nothing to switch
                        // to, so removing the last board returns the switcher to every board.
                        saveSet(next.length > 0 ? next : null)
                      }}
                    >
                      <X />
                    </Button>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t(
                'jira.settings.noSavedBoards',
                'No saved boards. The Tasks board switcher lists every board this account can reach, and this device remembers the last one you open.'
              )}
            </p>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="tasks-jira-add-board">
              {t('jira.settings.addBoard', 'Add a board')}
            </Label>
            <SettingsCombobox
              id="tasks-jira-add-board"
              value=""
              onValueChange={addBoard}
              options={boardOptions}
              placeholder={t('jira.settings.chooseBoard', 'Choose a board')}
              searchPlaceholder={t(
                'auto.components.settings.JiraBoardSettings.searchBoards',
                'Search boards by name...'
              )}
              emptyMessage={
                search.loading
                  ? t(
                      'auto.components.settings.JiraBoardSettings.loadingBoards',
                      'Loading boards...'
                    )
                  : t('jira.settings.noBoardsMatchAdd', 'No other boards match this search.')
              }
              disabled={search.loading && search.boards.length === 0}
              onSearchChange={search.setQuery}
            />
            <p className="text-xs text-muted-foreground">
              {t(
                'jira.settings.boardListHelp',
                'Search covers every connected Jira site and shows up to one page of boards per site. The Tasks switcher lists the saved boards in this order.'
              )}
            </p>
            {!search.loading && !search.error && boardOptions.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {search.query
                  ? t(
                      'auto.components.settings.JiraBoardSettings.noBoardsForSearch',
                      'Jira returned no boards matching this search.'
                    )
                  : t(
                      'jira.settings.noBoardsAvailable',
                      'Jira returned no other boards. Check that the account can see a board.'
                    )}
              </p>
            ) : null}
          </div>

          {search.error ? (
            <div
              role="alert"
              className="flex items-center justify-between gap-3 text-xs text-destructive"
            >
              <span className="min-w-0">{search.error}</span>
              <Button type="button" variant="outline" size="xs" onClick={search.retry}>
                {t('auto.components.settings.JiraBoardSettings.retry', 'Retry')}
              </Button>
            </div>
          ) : null}
        </div>
      </SearchableSetting>
    </section>
  )
}
