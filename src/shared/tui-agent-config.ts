import type { TuiAgent } from './tui-agent'
import { TUI_AGENT_CONFIG_SOURCE, type TuiAgentConfigSource } from './tui-agent-config-table'

export type AgentPromptInjectionMode =
  | 'argv'
  | 'flag-prompt'
  | 'flag-prompt-interactive'
  | 'flag-interactive'
  | 'hermes-query'
  | 'stdin-after-start'

export type DraftPasteReadySignal =
  | 'render-quiet-after-bracketed-paste'
  | 'codex-composer-prompt'
  | 'render-cursor-after-bracketed-paste'
  | 'grok-composer-prompt'
  | 'dsh-composer-prompt'
  | 'zcode-composer-prompt'

export type TuiAgentDetectionRuntime = NodeJS.Platform | 'wsl'

export type TuiAgentConfig = {
  detectCmd: string
  /** Additional executable names that identify the same agent on PATH. */
  detectCmdAliases?: readonly string[]
  /** Other commands that must also be present before this agent counts as installed. */
  detectRequiredCommands?: readonly string[]
  /** Detection runtimes where this launch mode is not available as a detected agent. */
  detectUnsupportedRuntimes?: readonly TuiAgentDetectionRuntime[]
  launchCmd: string
  /** Platform-specific launch command when the public binary name differs. */
  launchCmdByPlatform?: Partial<Record<NodeJS.Platform, string>>
  /**
   * Launch command for a REMOTE execution host, where the SSH relay's own shim runs under a fixed
   * name. Distinct from `launchCmdByPlatform` so a local rename cannot leak into a remote launch.
   */
  launchCmdByRemotePlatform?: Partial<Record<NodeJS.Platform, string>>
  expectedProcess: string
  promptInjectionMode: AgentPromptInjectionMode
  /** Option terminator required before positional prompts that may look like CLI syntax. */
  argvPromptSeparator?: '--'
  /** Native CLI flag that seeds the input without submitting (e.g. Claude's `--prefill <text>`); preferred over the paste-after-ready path. */
  draftPromptFlag?: string
  /** Startup env var that seeds the input without submitting, for agents with no `--prefill`-style flag (e.g. pi); avoids the paste-after-ready race. */
  draftPromptEnvVar?: string
  /** Claude Code follows pasted text only where the user's typed words ask, so dispatch briefs need a typed lead line. */
  pasteNeedsTypedRequest?: boolean
  /** Pre-write a trust artifact so the agent's first-launch "trust this folder?" menu doesn't consume the bracketed paste (see agent-trust-presets.ts). */
  preflightTrust?: 'cursor' | 'copilot' | 'codex' | 'antigravity' | 'qoder'
  /** Agent-specific signal that the composer is ready for paste, stronger than the default quiet-render window. */
  draftPasteReadySignal?: DraftPasteReadySignal
  /** Hard deadline for the agent's composer readiness signal. */
  draftPasteReadyTimeoutMs?: number
  /** Delay before one extra blind submit Enter, for agents that render their composer before Enter is live (codex); a no-op if the first Enter landed. */
  submitRetryDelayMs?: number
  /** Extra ms per logical prompt line before Enter, for TUIs that expand multiline paste slowly (antigravity). */
  submitLineSettleMsPerLine?: number
  /** Windows Shift+Enter encoding override; omitted agents keep the legacy Esc+CR path. */
  windowsShiftEnterEncoding?: 'csi-u'
  /** Paste newlines for TUIs that read Windows console input records instead of VT paste frames. */
  windowsInputRecordPasteNewline?: 'alt-enter' | 'csi-u'
  /** Ctrl+Enter encoding for agents that consume CSI-u without active kitty flags. */
  ctrlEnterEncoding?: 'csi-u'
}

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
