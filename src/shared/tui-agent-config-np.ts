import type { TuiAgent } from './tui-agent'
import { getRelayCliCommandNameForPlatform } from './orca-cli-command-name'
import type { TuiAgentConfigSource } from './tui-agent-config-types'

// Why: Orca NP's own entries over upstream's table, so upstream table edits still merge in place.
// `satisfies` rather than an annotation: it keeps the literal key type, so the merge below indexes
// `Record<TuiAgent, …>` without a cast.
const FORK_TUI_AGENT_OVERRIDES = {
  'claude-agent-teams': {
    detectCmd: 'orca-np',
    detectCmdAliases: ['orca-np-dev', 'orca-dev', 'orca-ide'],
    launchCmd: 'orca-np claude-teams',
    // Why: a remote launch runs the SSH relay's shim, which is deployed under a fixed name and is
    // not the command this fork installs locally. See orca-cli-command-name.ts.
    launchCmdByRemotePlatform: {
      darwin: `${getRelayCliCommandNameForPlatform('darwin')} claude-teams`,
      linux: `${getRelayCliCommandNameForPlatform('linux')} claude-teams`,
      win32: `${getRelayCliCommandNameForPlatform('win32')} claude-teams`
    }
  }
} satisfies Partial<Record<TuiAgent, Partial<TuiAgentConfigSource>>>

export function withForkTuiAgentOverrides(
  source: Record<TuiAgent, TuiAgentConfigSource>
): Record<TuiAgent, TuiAgentConfigSource> {
  const merged = { ...source }
  for (const [agent, override] of Object.entries(FORK_TUI_AGENT_OVERRIDES)) {
    merged[agent] = { ...source[agent], ...override }
  }
  return merged
}
