import { TUI_AGENT_CONFIG, isTuiAgent } from '../../../shared/agent-launch/catalog/tui-agent-config'
import {
  agentTrustLaunchArgs,
  withAgentTrustLaunchArgs
} from '../../../shared/agent-launch/startup/agent-trust-launch-args'
import type { AgentStartupShell } from '../../../shared/agent-launch/startup/tui-agent-startup-shell'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { isPathInsideOrEqual, resolveRuntimePath } from '../../../shared/cross-platform-path'
import { resolveTerminalWorkspacePath } from '../../../shared/shell/launch/terminal-startup-cwd'
import {
  applyAgentWorkspaceTrust,
  type AgentTrustLaunchContext,
  type AgentTrustSpawnFields
} from './agent-workspace-trust'
import { AGENT_TRUST_KEYED_BY_START_FOLDER } from './execution-host-workspace-trust'
import type { Repo } from '../../../shared/repo-types'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { splitWorktreeId } from '../../../shared/worktree/id'
import {
  shouldPreTrustAgentWorkspace,
  resolveAgentWorkspaceTrustOwner,
  type AgentWorkspaceTrustDecision
} from '../../../shared/agent-launch/permissions/agent-workspace-trust-decision'

type AgentWorkspaceTrustSetting =
  | Partial<Pick<GlobalSettings, 'agentWorkspaceTrustEnabled'>>
  | null
  | undefined

export type AgentWorkspaceTrustRepoLookup = {
  getRepo?: (repoId: string) => Pick<Repo, 'agentWorkspaceTrust'> | undefined
}

/** What decides whether this launch is Orca's to pre-trust; the trust write and the trust args share it. */
type AgentWorkspaceTrustGate = {
  launchAgent: unknown
  /** The user chose "let agents ask" for this launch; it wins even if saving that answer failed. */
  skipForThisLaunch?: boolean
  worktreeId: string | undefined
  /** Section root to pre-trust for this launch; never part of the terminal identity. */
  trustWorktreeId?: string
  store:
    | ({
        getFolderWorkspace: (id: string) => { folderPath: string } | undefined
      } & AgentWorkspaceTrustRepoLookup)
    | undefined
  isFreshLaunch: boolean
  settings: AgentWorkspaceTrustSetting
}

function preTrustsAgentLaunch(
  args: AgentWorkspaceTrustGate,
  trustWorkspaceId: string | undefined
): boolean {
  return (
    args.isFreshLaunch &&
    args.skipForThisLaunch !== true &&
    shouldPreTrustAgentWorkspace(
      args.settings?.agentWorkspaceTrustEnabled,
      agentWorkspaceTrustDecisionForWorkspace(trustWorkspaceId, args.store)
    )
  )
}

/**
 * Trust args this spawn may splice into its launch command; empty when the launch is not Orca's to
 * trust. Narrower than the trust write on purpose: a folder workspace or a floating terminal is a
 * folder the user opened, and the agent's own prompt is the only consent Orca has for it.
 */
export function resolveAgentWorkspaceTrustLaunchArgs(
  args: AgentWorkspaceTrustGate & { cwd: string | undefined }
): readonly string[] {
  const trustArgs = agentTrustLaunchArgs(args.launchAgent)
  if (trustArgs.length === 0) {
    return []
  }
  const trustWorkspaceId = resolveAgentWorkspaceTrustOwner(args)
  if (!trustWorkspaceId || !preTrustsAgentLaunch(args, trustWorkspaceId)) {
    return []
  }
  const scope = parseWorkspaceKey(trustWorkspaceId)
  if (scope?.type === 'folder') {
    return []
  }
  const workspaceRoot = resolveTerminalWorkspacePath(
    trustWorkspaceId,
    (folderWorkspaceId) => args.store?.getFolderWorkspace(folderWorkspaceId)?.folderPath
  )
  if (!workspaceRoot) {
    return []
  }
  // Why the start folder: a caller may point the agent outside the worktree (a cd'd cwd), and the
  // flag must not settle trust for a folder Orca did not create.
  const startFolder = args.cwd?.trim() ? resolveRuntimePath(workspaceRoot, args.cwd) : workspaceRoot
  return isPathInsideOrEqual(workspaceRoot, startFolder) ? trustArgs : []
}

/** The command this spawn runs: the authored one, with the agent's trust args spliced in when due. */
export function withAgentWorkspaceTrustLaunchArgs(
  args: AgentWorkspaceTrustGate & {
    cwd: string | undefined
    command: string
    shell: AgentStartupShell
  }
): string {
  return resolveAgentWorkspaceTrustLaunchArgs(args).length > 0 && isTuiAgent(args.launchAgent)
    ? withAgentTrustLaunchArgs(args.command, args.launchAgent, args.shell)
    : args.command
}

/** Folder workspaces and floating terminals have no repo, so only the global setting applies. */
export function agentWorkspaceTrustDecisionForWorkspace(
  workspaceId: string | undefined,
  store: AgentWorkspaceTrustRepoLookup | undefined
): AgentWorkspaceTrustDecision | undefined {
  const scope = workspaceId ? parseWorkspaceKey(workspaceId) : null
  if (!workspaceId || scope?.type === 'folder') {
    return undefined
  }
  const worktreeId = scope?.type === 'worktree' ? scope.worktreeId : workspaceId
  const repoId = splitWorktreeId(worktreeId)?.repoId
  return repoId ? store?.getRepo?.(repoId)?.agentWorkspaceTrust : undefined
}

/** Return null for no-op spawns: an extra async tick can reorder pane reservations. */
export function applyAgentWorkspaceTrustToSpawn(
  args: {
    launchAgent: unknown
    /** The user chose "let agents ask" for this launch; it wins even if saving that answer failed. */
    skipForThisLaunch?: boolean
    /** Placement workspace id; its root may differ from the agent’s starting folder. */
    worktreeId: string | undefined
    /** Section root to pre-trust for this launch; never part of the terminal identity. */
    trustWorktreeId?: string
    /** The resolved folder the agent starts in; floating terminals have only this. */
    cwd: string | undefined
    store:
      | ({
          getFolderWorkspace: (id: string) => { folderPath: string } | undefined
        } & AgentWorkspaceTrustRepoLookup)
      | undefined
    isFreshLaunch: boolean
    settings: AgentWorkspaceTrustSetting
    spawnOptions: AgentTrustSpawnFields
  } & AgentTrustLaunchContext
): Promise<void> | null {
  const trustWorkspaceId = resolveAgentWorkspaceTrustOwner(args)
  if (!preTrustsAgentLaunch(args, trustWorkspaceId)) {
    return null
  }
  const preset = isTuiAgent(args.launchAgent)
    ? TUI_AGENT_CONFIG[args.launchAgent].preflightTrust
    : undefined
  if (!preset) {
    return null
  }
  const workspaceRoot = resolveTerminalWorkspacePath(
    trustWorkspaceId,
    (folderWorkspaceId) => args.store?.getFolderWorkspace(folderWorkspaceId)?.folderPath
  )
  const workspacePath = AGENT_TRUST_KEYED_BY_START_FOLDER[preset]
    ? args.cwd || workspaceRoot
    : workspaceRoot
  if (!workspacePath) {
    return null
  }
  return applyAgentWorkspaceTrust(preset, workspacePath, {
    env: args.env,
    claudeAuth: args.claudeAuth,
    wslDistro: args.wslDistro,
    connectionId: args.connectionId,
    codexHome: args.codexHome
  }).then((fields) => {
    if (fields.agentWorkspaceTrust) {
      args.spawnOptions.agentWorkspaceTrust = fields.agentWorkspaceTrust
    }
  })
}

/** Read-only Codex chats need explicit folder trust to load .codex config. */
export async function applyStructuredCodexWorkspaceTrust(args: {
  workspacePath: string
  launchEnv: Record<string, string | undefined>
  codexHome: string
  settings: AgentWorkspaceTrustSetting
  repoDecision: AgentWorkspaceTrustDecision | undefined
}): Promise<void> {
  if (!shouldPreTrustAgentWorkspace(args.settings?.agentWorkspaceTrustEnabled, args.repoDecision)) {
    return
  }
  await applyAgentWorkspaceTrust('codex', args.workspacePath, {
    env: args.launchEnv,
    claudeAuth: null,
    wslDistro: null,
    connectionId: null,
    codexHome: args.codexHome
  })
}
