import React from 'react'
import { Loader2 } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAgentDetectionTargetForWorktree } from '@/hooks/useAgentDetectionTarget'
import { useDetectedAgents } from '@/hooks/useDetectedAgents'
import { getAgentCatalog, AgentIcon } from '@/lib/agent-catalog'
import { useStructuredAgentLaunchStatus } from '@/lib/structured-agent-session-launch'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { isAgentSessionHandleProvider } from '../../../../shared/agent-session-provider-handle'
import {
  DEFAULT_DISABLED_TUI_AGENTS,
  filterEnabledTuiAgents
} from '../../../../shared/tui-agent-selection'
import type { TuiAgent } from '../../../../shared/tui-agent'

export function TabBarDefaultAgentButton({
  worktreeId,
  onLaunchAgent
}: {
  worktreeId: string
  onLaunchAgent: (agent: TuiAgent) => void
}): React.JSX.Element | null {
  const detectionTarget = useAgentDetectionTargetForWorktree(worktreeId)
  const { detectedIds } = useDetectedAgents(detectionTarget)
  const defaultAgent = useAppStore((state) => state.settings?.defaultTuiAgent ?? null)
  const disabledAgents = useAppStore(
    (state) => state.settings?.disabledTuiAgents ?? DEFAULT_DISABLED_TUI_AGENTS
  )
  const structuredLaunchStatusByAgent = {
    claude: useStructuredAgentLaunchStatus(worktreeId, 'claude'),
    codex: useStructuredAgentLaunchStatus(worktreeId, 'codex')
  }

  const enabledDetectedAgents = detectedIds
    ? filterEnabledTuiAgents(detectedIds, disabledAgents)
    : []
  const agent: TuiAgent | null =
    defaultAgent && defaultAgent !== 'blank' && enabledDetectedAgents.includes(defaultAgent)
      ? defaultAgent
      : null

  if (!agent) {
    return null
  }

  const agentLabel = getAgentCatalog().find((entry) => entry.id === agent)?.label ?? agent
  const isLaunchPending =
    isAgentSessionHandleProvider(agent) && structuredLaunchStatusByAgent[agent] === 'pending'
  const label = translate(
    'auto.components.tab.bar.TabBarDefaultAgentButton.2a0cbdc8a1',
    'Open {{value0}} in a new tab',
    { value0: agentLabel }
  )

  const launchDefaultAgent = (): void => onLaunchAgent(agent)

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="ml-0.5 my-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: React's CSSProperties omits Electron's WebkitAppRegion titlebar property.
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          aria-label={label}
          disabled={isLaunchPending}
          onClick={launchDefaultAgent}
        >
          {isLaunchPending ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <AgentIcon agent={agent} size={14} />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
