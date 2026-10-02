// Fold-brain config from the user's text-generation settings (Settings → Git →
// Source Control AI): the same agent/model/thinking-level pickers that drive
// commit messages and PR fields — one settings source for app-run LLM work.
import { LOCAL_COMMIT_MESSAGE_HOST_KEY } from '../../shared/commit-message-host-key'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { ResolvedSourceControlAiGenerationParams } from '../../shared/source-control-ai'
import { resolveSourceControlAiForOperation } from '../../shared/source-control-ai'

/** The settings slice the source-control AI resolver requires. */
export type SessionSummaryFoldSettings = Pick<
  GlobalSettings,
  'defaultTuiAgent' | 'agentCmdOverrides' | 'commitMessageAi' | 'sourceControlAi'
> &
  Partial<Pick<GlobalSettings, 'disabledTuiAgents'>>

export function resolveSessionSummaryFoldParams(
  settings: SessionSummaryFoldSettings
): ResolvedSourceControlAiGenerationParams | null {
  // 'commitMessage' only selects which action recipe's agent/model applies —
  // summary folds ride the same generation stack. `enabled` is ignored on
  // purpose: it gates source-control features, not which model summaries use.
  const resolved = resolveSourceControlAiForOperation({
    settings,
    operation: 'commitMessage',
    discoveryHostKey: LOCAL_COMMIT_MESSAGE_HOST_KEY
  })
  return resolved.ok ? resolved.value.params : null
}
