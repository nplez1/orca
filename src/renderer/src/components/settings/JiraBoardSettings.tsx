import { useEffect, useMemo, useState } from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { JiraBoard, JiraField, JiraSiteSelection } from '../../../../shared/jira-types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import {
  jiraListBoards,
  jiraListCustomFields,
  type RuntimeJiraSettings
} from '@/runtime/runtime-jira-client'
import { SearchableSetting } from './SearchableSetting'
import {
  boardOptionValue,
  boardSelectionOptionValue,
  buildJiraBoardOptions,
  buildJiraTeamFieldOptions
} from './jira-settings-combobox-options'
import { SETTINGS_COMBOBOX_NONE, SettingsCombobox } from './SettingsCombobox'
import { getTasksPaneSearchKeywords } from './tasks-search'

type JiraBoardSettingsProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

// Why: the picker queries Jira by name, so every keystroke must not become a request.
const BOARD_SEARCH_DEBOUNCE_MS = 300

function isTeamFieldSupported(field: JiraField): boolean {
  return (
    !field.schemaType || ['any', 'number', 'option', 'string', 'team'].includes(field.schemaType)
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Jira settings could not be loaded.'
}

export function JiraBoardSettings({
  settings,
  updateSettings
}: JiraBoardSettingsProps): React.JSX.Element {
  const jiraStatus = useAppStore((state) => state.jiraStatus)
  const checkJiraConnection = useAppStore((state) => state.checkJiraConnection)
  const selectedSiteId: JiraSiteSelection | undefined =
    jiraStatus.selectedSiteId === 'all'
      ? 'all'
      : (jiraStatus.selectedSiteId ?? jiraStatus.activeSiteId ?? undefined)
  const runtimeSettings = useMemo<RuntimeJiraSettings>(
    () => ({ activeRuntimeEnvironmentId: settings.activeRuntimeEnvironmentId }),
    [settings.activeRuntimeEnvironmentId]
  )
  const selectedBoard = settings.defaultJiraBoard
  // Why: the custom-field list is site-scoped, not board-scoped. Keying it off the
  // selected board left the Team field disabled whenever no board was chosen —
  // including every case where the board list failed to load.
  const fieldSiteSelection: JiraSiteSelection | undefined = selectedBoard?.siteId ?? selectedSiteId
  const [boards, setBoards] = useState<JiraBoard[]>([])
  const [fields, setFields] = useState<JiraField[]>([])
  const [boardsLoading, setBoardsLoading] = useState(false)
  const [fieldsLoading, setFieldsLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [retryNonce, setRetryNonce] = useState(0)
  const [boardQuery, setBoardQuery] = useState('')
  const [appliedBoardQuery, setAppliedBoardQuery] = useState('')
  const [teamFieldQuery, setTeamFieldQuery] = useState('')
  const [teamValueDraft, setTeamValueDraft] = useState(settings.jiraTeamValue)

  useEffect(() => {
    setTeamValueDraft(settings.jiraTeamValue)
  }, [settings.jiraTeamValue])

  useEffect(() => {
    const timer = setTimeout(
      () => setAppliedBoardQuery(boardQuery.trim()),
      BOARD_SEARCH_DEBOUNCE_MS
    )
    return () => clearTimeout(timer)
  }, [boardQuery])

  useEffect(() => {
    let cancelled = false
    setBoardsLoading(true)
    setLoadError(null)
    void checkJiraConnection()
    void jiraListBoards(runtimeSettings, selectedSiteId, appliedBoardQuery || undefined)
      .then((nextBoards) => {
        if (!cancelled) {
          setBoards(nextBoards)
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadError(errorMessage(error))
          setBoards([])
        }
      })
      .finally(() => {
        if (!cancelled) {
          setBoardsLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [appliedBoardQuery, checkJiraConnection, retryNonce, runtimeSettings, selectedSiteId])

  useEffect(() => {
    let cancelled = false
    if (!fieldSiteSelection) {
      setFields([])
      return
    }
    setFieldsLoading(true)
    void jiraListCustomFields(runtimeSettings, fieldSiteSelection)
      .then((nextFields) => {
        if (!cancelled) {
          setFields(nextFields.filter(isTeamFieldSupported))
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadError(errorMessage(error))
          setFields([])
        }
      })
      .finally(() => {
        if (!cancelled) {
          setFieldsLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [fieldSiteSelection, retryNonce, runtimeSettings])

  const boardOptions = useMemo(
    () => [
      {
        value: SETTINGS_COMBOBOX_NONE,
        label: translate(
          'auto.components.settings.JiraBoardSettings.useListView',
          'No default board (use issue list)'
        )
      },
      ...buildJiraBoardOptions(
        boards,
        selectedBoard,
        translate('auto.components.settings.JiraBoardSettings.unnamedBoard', 'Board {{value0}}', {
          value0: selectedBoard?.boardId ?? ''
        })
      )
    ],
    [boards, selectedBoard]
  )
  const showFieldSiteNames = new Set(fields.map((field) => field.siteId)).size > 1
  const teamFieldOptions = useMemo(
    () => [
      {
        value: SETTINGS_COMBOBOX_NONE,
        label: translate('auto.components.settings.JiraBoardSettings.noTeamField', 'No Team field')
      },
      ...buildJiraTeamFieldOptions(fields, teamFieldQuery, showFieldSiteNames)
    ],
    [fields, showFieldSiteNames, teamFieldQuery]
  )
  const selectedBoardValue = selectedBoard
    ? boardSelectionOptionValue(selectedBoard)
    : SETTINGS_COMBOBOX_NONE

  const saveTeamValue = (): void => {
    const normalized = teamValueDraft.trim()
    setTeamValueDraft(normalized)
    if (normalized !== settings.jiraTeamValue) {
      updateSettings({ jiraTeamValue: normalized })
    }
  }

  return (
    <section className="space-y-3" data-settings-section="tasks-jira-board">
      <SearchableSetting
        title={translate('auto.components.settings.JiraBoardSettings.title', 'Jira board view')}
        description={translate(
          'auto.components.settings.JiraBoardSettings.description',
          'Choose a default board and the Jira custom field used by the Team filter in Tasks.'
        )}
        keywords={getTasksPaneSearchKeywords()}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="tasks-jira-default-board">
              {translate(
                'auto.components.settings.JiraBoardSettings.defaultBoard',
                'Default board'
              )}
            </Label>
            <SettingsCombobox
              id="tasks-jira-default-board"
              value={selectedBoardValue}
              onValueChange={(value) => {
                if (value === SETTINGS_COMBOBOX_NONE) {
                  updateSettings({ defaultJiraBoard: null })
                  return
                }
                const board = boards.find((candidate) => boardOptionValue(candidate) === value)
                if (!board) {
                  return
                }
                const siteChanged = board.siteId !== selectedBoard?.siteId
                updateSettings({
                  defaultJiraBoard: {
                    boardId: board.id,
                    siteId: board.siteId,
                    name: board.name
                  },
                  ...(siteChanged ? { jiraTeamFieldId: '', jiraTeamValue: '' } : {})
                })
              }}
              options={boardOptions}
              placeholder={translate(
                'auto.components.settings.JiraBoardSettings.chooseBoard',
                'Choose a board'
              )}
              searchPlaceholder={translate(
                'auto.components.settings.JiraBoardSettings.searchBoards',
                'Search boards by name...'
              )}
              emptyMessage={
                boardsLoading
                  ? translate(
                      'auto.components.settings.JiraBoardSettings.loadingBoards',
                      'Loading boards...'
                    )
                  : translate(
                      'auto.components.settings.JiraBoardSettings.noBoardsMatch',
                      'No boards match this search.'
                    )
              }
              disabled={boardsLoading && boards.length === 0}
              onSearchChange={setBoardQuery}
            />
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.JiraBoardSettings.defaultBoardHelp',
                'The board applies its saved filter. Scrum boards show active-sprint status columns; backlog follows the board filter. Search to find a board on a Jira site with many.'
              )}
            </p>
            {!boardsLoading && !loadError && boards.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {appliedBoardQuery
                  ? translate(
                      'auto.components.settings.JiraBoardSettings.noBoardsForSearch',
                      'Jira returned no boards matching this search.'
                    )
                  : translate(
                      'auto.components.settings.JiraBoardSettings.noBoardsReturned',
                      'Jira returned no boards for this site. Check that the account can see a board.'
                    )}
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="tasks-jira-team-field">
              {translate('auto.components.settings.JiraBoardSettings.teamField', 'Team field')}
            </Label>
            <SettingsCombobox
              id="tasks-jira-team-field"
              value={settings.jiraTeamFieldId || SETTINGS_COMBOBOX_NONE}
              onValueChange={(value) => {
                updateSettings({
                  jiraTeamFieldId: value === SETTINGS_COMBOBOX_NONE ? '' : value,
                  jiraTeamValue: ''
                })
              }}
              options={teamFieldOptions}
              placeholder={translate(
                'auto.components.settings.JiraBoardSettings.chooseTeamField',
                'Choose a custom field'
              )}
              searchPlaceholder={translate(
                'auto.components.settings.JiraBoardSettings.searchTeamFields',
                'Search fields by name or ID...'
              )}
              emptyMessage={
                fieldsLoading
                  ? translate(
                      'auto.components.settings.JiraBoardSettings.loadingTeamFields',
                      'Loading custom fields...'
                    )
                  : translate(
                      'auto.components.settings.JiraBoardSettings.noTeamFieldsMatch',
                      'No custom fields match this search.'
                    )
              }
              disabled={fieldsLoading || !fieldSiteSelection}
              onSearchChange={setTeamFieldQuery}
            />
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.JiraBoardSettings.teamFieldHelp',
                'Text, number, single-select, and Jira Team custom fields are supported.'
              )}
            </p>
          </div>
        </div>

        {settings.jiraTeamFieldId ? (
          <div className="max-w-md space-y-2">
            <Label htmlFor="tasks-jira-team-value">
              {translate('auto.components.settings.JiraBoardSettings.teamValue', 'Team value')}
            </Label>
            <Input
              id="tasks-jira-team-value"
              value={teamValueDraft}
              onChange={(event) => setTeamValueDraft(event.target.value)}
              onBlur={saveTeamValue}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.currentTarget.blur()
                }
              }}
              placeholder={translate(
                'auto.components.settings.JiraBoardSettings.teamValuePlaceholder',
                'Exact value from the selected Jira field'
              )}
              className="max-w-md"
            />
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.JiraBoardSettings.teamValueHelp',
                'Issues match this Jira field value exactly. For option and Jira Team values, enter the ID.'
              )}
            </p>
          </div>
        ) : null}

        {loadError ? (
          <div
            role="alert"
            className="flex items-center justify-between gap-3 text-xs text-destructive"
          >
            <span className="min-w-0">{loadError}</span>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => setRetryNonce((nonce) => nonce + 1)}
            >
              {translate('auto.components.settings.JiraBoardSettings.retry', 'Retry')}
            </Button>
          </div>
        ) : null}
      </SearchableSetting>
    </section>
  )
}
