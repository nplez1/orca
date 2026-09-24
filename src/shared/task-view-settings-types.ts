import type { JiraBoardSelection } from './jira-types'
import type { TaskProvider } from './task-providers'
import type { TaskViewPresetId } from './ui-chrome-types'

export type TaskViewSettings = {
  /** Default preset in the new-workspace GitHub task view. */
  defaultTaskViewPreset: TaskViewPresetId
  /** Persisted last-used task source so Tasks reopens to the same provider instead of defaulting to GitHub. */
  defaultTaskSource: TaskProvider
  /** Persisted visible task providers; hides unused providers from Tasks chrome and sidebar shortcuts. */
  visibleTaskProviders: TaskProvider[]
  /** Why: one-shot guard to make Jira visible for existing profiles once, without re-adding after a later opt-out. */
  visibleTaskProvidersDefaultedForJira: boolean
  /** Persisted repo selection (cross-repo tasks view). null = sticky-all (includes future-added repos);
   *  string[] = frozen curated subset (ineligible ids dropped on load; empty after drop is treated as null). */
  defaultRepoSelection: string[] | null
  /** Persisted Linear team selection (tasks view). Same nullable-array pattern as
   *  defaultRepoSelection: null = sticky-all, string[] = frozen subset of team IDs. */
  defaultLinearTeamSelection: string[] | null
  /** Optional Jira board for the Jira Tasks board view. */
  defaultJiraBoard: JiraBoardSelection | null
  /** Jira custom field used by the Tasks view's Team filter. */
  jiraTeamFieldId: string
  /** Exact Jira team field value used by the Tasks view's Team filter. */
  jiraTeamValue: string
}
