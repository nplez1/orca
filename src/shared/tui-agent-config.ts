import type { TuiAgent } from './tui-agent'
import type { TuiAgentConfig } from './tui-agent-config-types'
import { TUI_AGENT_CONFIG_SOURCE, type TuiAgentConfigSource } from './tui-agent-config-table'

export type {
  AgentPromptInjectionMode,
  DraftPasteReadySignal,
  TuiAgentConfig,
  TuiAgentDetectionRuntime
} from './tui-agent-config-types'

function resolveTuiAgentConfig(source: TuiAgentConfigSource): TuiAgentConfig {
  return {
    ...source,
    launchCmd: source.launchCmd ?? source.detectCmd,
    expectedProcess: source.expectedProcess ?? source.detectCmd
  }
}

export const TUI_AGENT_CONFIG: Record<TuiAgent, TuiAgentConfig> = Object.fromEntries(
  Object.entries(TUI_AGENT_CONFIG_SOURCE).map(([agent, source]) => [
    agent,
    resolveTuiAgentConfig(source)
  ])
) as Record<TuiAgent, TuiAgentConfig>

export function isTuiAgent(value: unknown): value is TuiAgent {
  return typeof value === 'string' && Object.hasOwn(TUI_AGENT_CONFIG, value)
}

export function getTuiAgentDetectCommands(config: TuiAgentConfig): string[] {
  return [config.detectCmd, ...(config.detectCmdAliases ?? [])]
}

export function getTuiAgentLaunchCommand(
  config: TuiAgentConfig,
  platform: NodeJS.Platform,
  opts?: { isRemote?: boolean }
): string {
  // Why: a remote launch runs the SSH relay's shim, which is deployed under a fixed name, so the
  // locally installed command must never leak there — it is not on the remote PATH.
  // Why every remote platform and not just Linux: Windows only shared one name between local and
  // remote before this fork renamed its local command.
  if (opts?.isRemote) {
    return config.launchCmdByRemotePlatform?.[platform] ?? config.launchCmd
  }
  return config.launchCmdByPlatform?.[platform] ?? config.launchCmd
}
