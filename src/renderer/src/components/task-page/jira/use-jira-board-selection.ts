import { useCallback, useMemo, useState } from 'react'
import type {
  JiraBoardSelection,
  JiraConnectionStatus
} from '../../../../../shared/jira/jira-types'
import {
  connectedJiraSiteIds,
  effectiveJiraBoardSet,
  resolveJiraSelectedBoard
} from '../../../../../shared/jira/jira-board-selection'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import { loadJiraBoardDevicePick, saveJiraBoardDevicePick } from '../../jira-board-view-storage'
import type { JiraBoardDevicePick } from '../../jira-board-view-storage'

type JiraBoardSelectionSource = {
  settings: Pick<GlobalSettings, 'defaultJiraBoards' | 'defaultJiraBoard'> | null | undefined
  jiraStatus: JiraConnectionStatus
  jiraStatusReady: boolean
}

export type JiraBoardSelectionModel = {
  /** The curated boards, or null for sticky-all: the switcher then offers every board Jira
   *  returns. */
  jiraSavedBoards: JiraBoardSelection[] | null
  /** The board the Tasks view shows, or null for the flat issue list. */
  jiraSelectedBoard: JiraBoardSelection | null
  /** Sites that can serve a board right now; null when the status cannot say yet. */
  jiraConnectedSiteIds: ReadonlySet<string> | null
  selectJiraBoard: (selection: JiraBoardSelection | null) => void
}

/** Which board the Tasks view shows.
 *
 *  Derived on every render rather than written back: the curated set is a setting, and the board
 *  this device last opened is a preference. Writing the resolved board into either would turn a
 *  temporary condition (a site that is briefly unreachable) into a permanent choice. */
export function useJiraBoardSelection(model: JiraBoardSelectionSource): JiraBoardSelectionModel {
  const [pick, setPick] = useState<JiraBoardDevicePick | null>(loadJiraBoardDevicePick)
  const savedBoardsSetting = model.settings?.defaultJiraBoards
  const legacyBoardSetting = model.settings?.defaultJiraBoard
  const savedBoards = useMemo(
    () =>
      effectiveJiraBoardSet({
        defaultJiraBoards: savedBoardsSetting,
        defaultJiraBoard: legacyBoardSetting
      }),
    [savedBoardsSetting, legacyBoardSetting]
  )
  const connectedSiteIds = useMemo(
    () => connectedJiraSiteIds(model.jiraStatus, model.jiraStatusReady),
    [model.jiraStatus, model.jiraStatusReady]
  )
  const jiraSelectedBoard = useMemo(
    () =>
      resolveJiraSelectedBoard({
        savedBoards,
        lastSelected: pick?.selection ?? null,
        lastSelectedFromCuratedSet: pick?.curated ?? false,
        connectedSiteIds
      }),
    [connectedSiteIds, pick, savedBoards]
  )
  // Why the curated flag: a pick made from a curated set belongs to that set, so removing the
  // last saved board (sticky-all again) must not bring a removed board back.
  const selectJiraBoard = useCallback(
    (selection: JiraBoardSelection | null): void => {
      const next = selection ? { selection, curated: savedBoards !== null } : null
      setPick(next)
      saveJiraBoardDevicePick(next)
    },
    [savedBoards]
  )
  return {
    jiraSavedBoards: savedBoards,
    jiraSelectedBoard,
    jiraConnectedSiteIds: connectedSiteIds,
    selectJiraBoard
  }
}
