import { useEffect, useMemo, useState } from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { JiraBoard, JiraField, JiraSiteSelection } from '../../../../shared/jira-types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import {
  jiraListBoards,
  jiraListCustomFields,
  type RuntimeJiraSettings
} from '@/runtime/runtime-jira-client'
import { SearchableSetting } from './SearchableSetting'
import { getTasksPaneSearchKeywords } from './tasks-search'

type JiraBoardSettingsProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

function boardSelectionValue(board: Pick<JiraBoard, 'siteId' | 'id'>): string {
  return `${encodeURIComponent(board.siteId)}:${encodeURIComponent(board.id)}`
}

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
  const fieldSiteId = selectedBoard?.siteId
  const [boards, setBoards] = useState<JiraBoard[]>([])
  const [fields, setFields] = useState<JiraField[]>([])
  const [boardsLoading, setBoardsLoading] = useState(false)
  const [fieldsLoading, setFieldsLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [retryNonce, setRetryNonce] = useState(0)
  const [teamValueDraft, setTeamValueDraft] = useState(settings.jiraTeamValue)

  useEffect(() => {
    setTeamValueDraft(settings.jiraTeamValue)
  }, [settings.jiraTeamValue])

  useEffect(() => {
    let cancelled = false
    setBoardsLoading(true)
    setLoadError(null)
    void checkJiraConnection()
    void jiraListBoards(runtimeSettings, selectedSiteId)
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
  }, [checkJiraConnection, retryNonce, runtimeSettings, selectedSiteId])

  useEffect(() => {
    let cancelled = false
    if (!fieldSiteId) {
      setFields([])
      return
    }
    setFieldsLoading(true)
    void jiraListCustomFields(runtimeSettings, fieldSiteId)
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
  }, [fieldSiteId, retryNonce, runtimeSettings])

  const selectedBoardValue = selectedBoard
    ? `${encodeURIComponent(selectedBoard.siteId)}:${encodeURIComponent(selectedBoard.boardId)}`
    : '__no-board__'

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
            <Select
              value={selectedBoardValue}
              onValueChange={(value) => {
                if (value === '__no-board__') {
                  updateSettings({ defaultJiraBoard: null })
                  return
                }
                const board = boards.find((candidate) => boardSelectionValue(candidate) === value)
                if (!board) {
                  return
                }
                const siteChanged = board.siteId !== selectedBoard?.siteId
                updateSettings({
                  defaultJiraBoard: { boardId: board.id, siteId: board.siteId },
                  ...(siteChanged ? { jiraTeamFieldId: '', jiraTeamValue: '' } : {})
                })
              }}
            >
              <SelectTrigger id="tasks-jira-default-board" disabled={boardsLoading}>
                <SelectValue
                  placeholder={translate(
                    'auto.components.settings.JiraBoardSettings.chooseBoard',
                    'Choose a board'
                  )}
                />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__no-board__">
                  {translate(
                    'auto.components.settings.JiraBoardSettings.useListView',
                    'No default board (use issue list)'
                  )}
                </SelectItem>
                {boards.map((board) => (
                  <SelectItem key={boardSelectionValue(board)} value={boardSelectionValue(board)}>
                    {boards.some((candidate) => candidate.siteId !== board.siteId)
                      ? `${board.name} · ${board.siteName}`
                      : board.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.JiraBoardSettings.defaultBoardHelp',
                'The board applies its saved filter. Scrum boards show active-sprint status columns; backlog follows the board filter.'
              )}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="tasks-jira-team-field">
              {translate('auto.components.settings.JiraBoardSettings.teamField', 'Team field')}
            </Label>
            <Select
              value={settings.jiraTeamFieldId || '__no-field__'}
              onValueChange={(value) => {
                updateSettings({
                  jiraTeamFieldId: value === '__no-field__' ? '' : value,
                  jiraTeamValue: ''
                })
              }}
            >
              <SelectTrigger id="tasks-jira-team-field" disabled={fieldsLoading || !fieldSiteId}>
                <SelectValue
                  placeholder={translate(
                    'auto.components.settings.JiraBoardSettings.chooseTeamField',
                    'Choose a custom field'
                  )}
                />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__no-field__">
                  {translate(
                    'auto.components.settings.JiraBoardSettings.noTeamField',
                    'No Team field'
                  )}
                </SelectItem>
                {fields.map((field) => (
                  <SelectItem key={field.id} value={field.id}>
                    {field.name} ({field.id})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
