import { useAgentDetectionTargetForWorktree } from '@/hooks/useAgentDetectionTarget'
import { useDetectedAgents } from '@/hooks/useDetectedAgents'
import { useStructuredAgentLaunchStatus } from '@/lib/structured-agent-session-launch'
import { useAppStore } from '@/store'
import { isAgentSessionHandleProvider } from '../../../../shared/agent-session-provider-handle'
import {
  DEFAULT_DISABLED_TUI_AGENTS,
  filterEnabledTuiAgents
} from '../../../../shared/tui-agent-selection'
import type { TuiAgent } from '../../../../shared/tui-agent'

/** The preferred agent when it is enabled and detected on this worktree's host, else null. */
export function resolveLaunchableDefaultAgent(
  defaultAgent: TuiAgent | 'blank' | null | undefined,
  detectedIds: readonly TuiAgent[] | null,
  disabledAgents: Iterable<unknown> | null | undefined
): TuiAgent | null {
  if (!defaultAgent || defaultAgent === 'blank' || detectedIds === null) {
    return null
  }
  return filterEnabledTuiAgents(detectedIds, disabledAgents).includes(defaultAgent)
    ? defaultAgent
    : null
}

/**
 * The default agent a tab-bar launch surface may offer, plus whether a structured launch for
 * it is already in flight. `enabled: false` skips detection entirely — floating panels own
 * their agent affordance and must not probe the synthetic floating worktree.
 */
export function useTabBarDefaultAgent(
  worktreeId: string,
  enabled = true
): { agent: TuiAgent | null; isAgentLaunchPending: boolean } {
  const detectionTarget = useAgentDetectionTargetForWorktree(worktreeId)
  const { detectedIds } = useDetectedAgents(enabled ? detectionTarget : undefined)
  const defaultAgent = useAppStore((state) => state.settings?.defaultTuiAgent ?? null)
  const disabledAgents = useAppStore(
    (state) => state.settings?.disabledTuiAgents ?? DEFAULT_DISABLED_TUI_AGENTS
  )
  // One hook per structured provider: the launch registry is keyed by agent, and hooks
  // cannot run inside a render loop.
  const structuredLaunchStatusByAgent = {
    claude: useStructuredAgentLaunchStatus(worktreeId, 'claude'),
    codex: useStructuredAgentLaunchStatus(worktreeId, 'codex')
  }

  const agent = enabled
    ? resolveLaunchableDefaultAgent(defaultAgent, detectedIds, disabledAgents)
    : null
  const isAgentLaunchPending =
    agent !== null &&
    isAgentSessionHandleProvider(agent) &&
    structuredLaunchStatusByAgent[agent] === 'pending'

  return { agent, isAgentLaunchPending }
}
