import { SquareTerminal } from 'lucide-react'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import type { Automation } from '../../../../shared/automations/automation-definition'

export function AutomationRunnerIcon({
  agentId,
  size
}: {
  agentId: Automation['agentId']
  size: number
}): React.JSX.Element {
  return agentId ? (
    <AgentIcon agent={agentId} size={size} />
  ) : (
    <SquareTerminal size={size} className="shrink-0 text-muted-foreground" aria-hidden="true" />
  )
}
