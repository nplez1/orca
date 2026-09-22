import { AI_VAULT_AGENTS, type AiVaultAgent } from '../../../../shared/ai-vault-types'
import { filterEnabledTuiAgents } from '../../../../shared/tui-agent-selection'

/**
 * Agents the user has switched on in Settings → Agents. This is the panel's whole
 * universe: a disabled agent gets neither a filter-menu row nor a listed session.
 */
export function enabledAiVaultAgentsForSettings(
  disabledTuiAgents: Iterable<unknown> | null | undefined
): AiVaultAgent[] {
  return filterEnabledTuiAgents(AI_VAULT_AGENTS, disabledTuiAgents)
}
