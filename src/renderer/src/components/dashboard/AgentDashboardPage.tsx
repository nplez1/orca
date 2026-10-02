import { useCallback } from 'react'
import { useAppStore } from '@/store'
import { AgentKanbanBoard } from '../dashboard-popout/AgentKanbanBoard'
import type { AgentRevealArgs } from '../dashboard-popout/AgentTerminalDialog'
import { AgentDashboardSettingsMenu } from './AgentDashboardSettingsMenu'
import { revealDashboardAgent } from './reveal-dashboard-agent'
import { useLiveDashboardSnapshot } from './useLiveDashboardSnapshot'

/**
 * The Agent Dashboard as a first-class top-level view, rendered in the content
 * area like Tasks/Automations. Mounts only while `activeView === 'dashboard'`,
 * so the live snapshot derivation stays off the closed path.
 */
export default function AgentDashboardPage(): React.JSX.Element {
  const snapshot = useLiveDashboardSnapshot()

  const handleAckAgent = useCallback((paneKey: string) => {
    useAppStore.getState().acknowledgeAgents([paneKey])
  }, [])
  const handleRevealAgent = useCallback((args: AgentRevealArgs) => {
    // Why: activating the agent's workspace switches activeView to 'terminal',
    // which unmounts this page — no explicit close needed.
    revealDashboardAgent(args)
  }, [])

  return (
    <div data-agent-dashboard-page="" className="h-full w-full">
      <AgentKanbanBoard
        snapshot={snapshot}
        containerClassName="h-full w-full"
        onAckAgent={handleAckAgent}
        onRevealAgent={handleRevealAgent}
        toolbarActions={<AgentDashboardSettingsMenu />}
      />
    </div>
  )
}
