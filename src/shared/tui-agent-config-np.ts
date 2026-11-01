import type { TuiAgent } from './tui-agent'
import { getRelayCliCommandNameForPlatform } from './orca-cli-command-name'
import type { TuiAgentConfigSource } from './tui-agent-config-types'

// Why: Orca NP's own entries over upstream's table, so upstream table edits still merge in place.
// `satisfies` rather than an annotation: the literal values must satisfy the config source type without
// widening it. `withForkTuiAgentOverrides` reads it through a string-keyed copy for the same reason.
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
  // Why the string-keyed working copy: `Object.entries` widens the override keys to `string`,
  // and the strict mobile typecheck refuses to index `Record<TuiAgent, …>` with one. A string
  // index signature is assignable back to the narrow record, so no assertion is needed.
  const merged: Record<string, TuiAgentConfigSource> = { ...source }
  for (const [agent, override] of Object.entries(FORK_TUI_AGENT_OVERRIDES)) {
    merged[agent] = { ...merged[agent], ...override }
  }
  return merged
}
