import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { markQoderWorkspaceTrusted } from './qoder/workspace-trust'
import {
  type AgentTrustPreset,
  markAntigravityWorkspaceTrusted,
  markCodexProjectTrusted,
  markCopilotFolderTrusted,
  markCursorWorkspaceTrusted,
  markKimiWorkspaceTrusted
} from './agent-trust-presets'
import { awaitAgentTrustWriteWithinDeadline } from './agent-trust-write-deadline'
import {
  type ClaudeTrustConfigTarget,
  grantClaudeWorkspaceTrust
} from './claude/claude-folder-trust-file'
import { isTooBroadToPreTrust } from '../shared/home-or-filesystem-root'

/** Resolve trust on the agent’s execution host, including WSL guests and SSH relays. */
export type WorkspaceTrustHost = {
  /** Homes the agent may read trust under; with none known, an agent that inherits trust writes nothing. */
  homes: readonly (string | null | undefined)[]
  /** The home the launched agent resolves `~` to, where the per-user trust files live. */
  agentHome: string
  /** The config Claude reads on this host, or null when this host cannot tell. */
  claudeConfig: () => ClaudeTrustConfigTarget | null
  /** Every config.toml the launched Codex may read, in the hook installer's lock order. */
  codexConfigFiles: () => readonly string[]
  /** KIMI_CODE_HOME for the launched Kimi; unset means `<agentHome>/.kimi-code`. */
  kimiHome?: string
  deadlineMs: number
}

/** The home an agent launched with `launchEnv` on this host resolves `~` to. */
export function launchedAgentHome(
  launchEnv: Record<string, string | undefined> | undefined
): string {
  return (process.platform === 'win32' ? launchEnv?.USERPROFILE : launchEnv?.HOME) || homedir()
}

/** Never prewrite home/root trust for agents whose trust lookup includes descendants. */
export const AGENT_TRUST_INHERITS_FROM_A_HOME: Record<AgentTrustPreset, boolean> = {
  claude: true,
  codex: false,
  cursor: false,
  copilot: true,
  qoder: true,
  'qoder-cn': true,
  antigravity: false,
  kimi: false
}

/** Exact-folder agents that load project config (Kimi: MCP servers) from a trusted home or root. */
const AGENT_TRUST_UNSAFE_AT_A_HOME: ReadonlySet<AgentTrustPreset> = new Set(['kimi'])

/** Trust these agents’ starting folders; a workspace ancestor may not be a valid trust key. */
export const AGENT_TRUST_KEYED_BY_START_FOLDER: Record<AgentTrustPreset, boolean> = {
  claude: false,
  codex: true,
  cursor: false,
  copilot: false,
  qoder: false,
  'qoder-cn': false,
  antigravity: false,
  kimi: true
}

// Why resolve() too: Claude stores it, and it collapses `..` even where realpath fails.
// Why async: realpath on the workspace path is a probe of the repo's volume; a stalled one would
// freeze the app on the launch path this guard runs on.
async function withResolvedForm(path: string): Promise<string[]> {
  try {
    return [path, resolve(path), await realpath(path)]
  } catch {
    return [path, resolve(path)]
  }
}

/**
 * Whether trust stored for `storedPath` would cover a home: it is a root, a home or a folder
 * above one. Both sides are compared given and resolved, since the writers store the realpath.
 */
async function wouldTrustAHome(storedPath: string, homes: readonly string[]): Promise<boolean> {
  const homeForms = (await Promise.all(homes.map(withResolvedForm))).flat()
  const storedForms = await withResolvedForm(storedPath)
  return storedForms.some((form) => isTooBroadToPreTrust(form, homeForms))
}

async function writePreset(
  preset: AgentTrustPreset,
  storedPath: string,
  host: WorkspaceTrustHost
): Promise<void> {
  switch (preset) {
    case 'claude': {
      const target = host.claudeConfig()
      if (target) {
        await grantClaudeWorkspaceTrust(target, storedPath)
      }
      return
    }
    case 'codex':
      return markCodexProjectTrusted(storedPath, host.codexConfigFiles())
    case 'cursor':
      return markCursorWorkspaceTrusted(storedPath, host.agentHome)
    case 'copilot':
      return markCopilotFolderTrusted(storedPath, host.agentHome)
    case 'qoder-cn':
      return markQoderWorkspaceTrusted(storedPath, host.agentHome, '.qoder-cn')
    case 'qoder':
      return markQoderWorkspaceTrusted(storedPath, host.agentHome)
    case 'antigravity':
      return markAntigravityWorkspaceTrusted(storedPath, host.agentHome)
    case 'kimi':
      return markKimiWorkspaceTrusted(
        storedPath,
        host.kimiHome || join(host.agentHome, '.kimi-code')
      )
  }
}

/**
 * The home guard and then the write. Chained rather than awaited apart so the launch's deadline
 * bounds the guard too: its realpath probes run on the workspace's volume, and a stalled one must
 * not hold the agent launch open — past the deadline the agent merely asks.
 */
async function writePresetAfterHomeGuard(
  preset: AgentTrustPreset,
  storedPath: string,
  host: WorkspaceTrustHost
): Promise<void> {
  if (AGENT_TRUST_INHERITS_FROM_A_HOME[preset] || AGENT_TRUST_UNSAFE_AT_A_HOME.has(preset)) {
    const homes = host.homes.filter((home): home is string => Boolean(home))
    if (homes.length === 0 || (await wouldTrustAHome(storedPath, homes))) {
      return
    }
  }
  await writePreset(preset, storedPath, host)
}

/**
 * The one place a preset's trust is written, on the host that runs the agent. For an agent that
 * inherits trust from a home, refuses when the path the writer would store covers a home. Never
 * throws or waits past the host's deadline: any failure or miss means the agent asks.
 */
export async function applyWorkspaceTrustOnThisHost(
  preset: AgentTrustPreset,
  workspacePath: string,
  describeHost: () => WorkspaceTrustHost
): Promise<void> {
  try {
    const host = describeHost()
    await awaitAgentTrustWriteWithinDeadline(
      writePresetAfterHomeGuard(preset, workspacePath, host),
      { preset, workspacePath, deadlineMs: host.deadlineMs }
    )
  } catch (error) {
    console.warn(
      `[agent-trust] ${preset} trust for ${workspacePath} failed; the agent will ask`,
      error
    )
  }
}
