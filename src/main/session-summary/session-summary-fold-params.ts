// Fold-brain config for a session summary: which agent, model, and effort fold it.
//
// Its own setting (Settings → Agents → Session summaries) rather than a Source
// Control AI operation, so summary cost is tunable without changing commit
// messages, and a summary never silently inherits that choice.
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { ResolvedSourceControlAiGenerationParams } from '../../shared/source-control-ai'
import { resolveSessionSummaryAiParams } from '../../shared/session-summary-ai'

/** The settings slice the session-summary AI resolver reads. */
export type SessionSummaryFoldSettings = Pick<
  GlobalSettings,
  'defaultTuiAgent' | 'agentCmdOverrides' | 'sessionSummaryAi'
> &
  Partial<Pick<GlobalSettings, 'disabledTuiAgents'>>

export function resolveSessionSummaryFoldParams(
  settings: SessionSummaryFoldSettings
): ResolvedSourceControlAiGenerationParams | null {
  return resolveSessionSummaryAiParams(settings)
}
