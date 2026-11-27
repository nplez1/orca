import { botAgentLabel } from '@/components/bots/bot-presentation'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { Automation } from '../../../../shared/automations/automation-definition'
import { getAgentLabel } from './authoring/automation-draft-model'

/** What an automation runs, by name: its agent, or a script when it launches none. */
export function getAutomationRunnerLabel(
  automation: Pick<Automation, 'agentId' | 'bot'>,
  t: Translate = translate
): string {
  if (!automation.agentId) {
    return t('automations.command.script', 'Script')
  }
  return automation.bot ? botAgentLabel(automation.agentId) : getAgentLabel(automation.agentId)
}
