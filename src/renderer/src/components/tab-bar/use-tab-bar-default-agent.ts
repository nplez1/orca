import { useAgentDetectionTargetForWorktree } from '@/hooks/useAgentDetectionTarget'
import { useDetectedAgents } from '@/hooks/useDetectedAgents'
import { useStructuredAgentLaunchStatus } from '@/lib/structured-agent-session-launch'
import { useAppStore } from '@/store'
import { isAgentSessionHandleProvider } from '../../../../shared/agent-session-provider-handle'
import {
  DEFAULT_DISABLED_TUI_AGENTS,
  filterEnabledTuiAgents,
  isTuiAgentEnabled
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
 * The configured default agent when it is enabled, with no detection probe. The floating
 * workspace runs on a synthetic worktree that has no detected agents, and its launch path
 * resolves a genuinely missing agent itself, so availability there is settings alone.
 */
export function resolveConfiguredDefaultAgent(
  defaultAgent: TuiAgent | 'blank' | null | undefined,
  disabledAgents: Iterable<unknown> | null | undefined
): TuiAgent | null {
  if (!defaultAgent || defaultAgent === 'blank') {
    return null
  }
  return isTuiAgentEnabled(defaultAgent, disabledAgents) ? defaultAgent : null
}

/**
 * Where the tab strip's create control gets the agent it offers:
 * - `detected`: the configured default agent, but only where this worktree's host detects it.
 * - `configured`: the configured default agent alone, for a host with no detection data.
 * - `none`: no agent; the control stays the plain "+".
 */
export type DefaultAgentSource = 'detected' | 'configured' | 'none'

/**
 * The default agent a tab-bar launch surface may offer, plus whether a structured launch for
 * it is already in flight. Only `detected` probes the worktree — a floating panel's synthetic
 * worktree has nothing to detect, so it names the source it wants instead.
 */
export function useTabBarDefaultAgent(
  worktreeId: string,
  source: DefaultAgentSource = 'detected'
): { agent: TuiAgent | null; isAgentLaunchPending: boolean } {
  const detectionTarget = useAgentDetectionTargetForWorktree(worktreeId)
  const { detectedIds } = useDetectedAgents(source === 'detected' ? detectionTarget : undefined)
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

  const agent =
    source === 'none'
      ? null
      : source === 'configured'
        ? resolveConfiguredDefaultAgent(defaultAgent, disabledAgents)
        : resolveLaunchableDefaultAgent(defaultAgent, detectedIds, disabledAgents)
  const isAgentLaunchPending =
    agent !== null &&
    isAgentSessionHandleProvider(agent) &&
    structuredLaunchStatusByAgent[agent] === 'pending'

  return { agent, isAgentLaunchPending }
}
