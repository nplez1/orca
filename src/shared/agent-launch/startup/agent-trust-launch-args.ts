import { getCommandTokenPathBasename, getFirstCommandToken } from '../../command-token-scanner'
import { TUI_AGENT_CONFIG } from '../catalog/tui-agent-config'
import type { TuiAgent } from '../catalog/tui-agent'
import {
  clearEnvCommand,
  commandSeparator,
  tokenizeStartupCommand,
  type AgentStartupShell
} from './tui-agent-startup-shell'

/**
 * Per-agent launch args that settle the agent's own folder-trust prompt for one run.
 *
 * Why pi: it gates project-local resources (`.pi` settings and extensions, project `.agents/skills`)
 * on a decision stored per canonical path in `~/.pi/agent/trust.json`, so a worktree under a trusted
 * parent still prompts — and an orchestrated launch has nobody to answer it. `--approve` is pi's own
 * "trust project-local files for this run": scoped to the process, and it persists nothing.
 */
const AGENT_TRUST_LAUNCH_ARGS = {
  pi: ['--approve']
} satisfies Partial<Record<TuiAgent, readonly string[]>>

// Why a string-keyed copy: `Object.hasOwn` narrows nothing, and the strict typecheck refuses to index
// a `Partial<Record<TuiAgent, …>>` with a plain string.
const TRUST_ARGS_BY_AGENT: Readonly<Record<string, readonly string[]>> = AGENT_TRUST_LAUNCH_ARGS

/** An explicit decision in the launch args is the user's; Orca never overrides one. */
const TRUST_DECISION_FLAGS = new Set(['-a', '--approve', '-na', '--no-approve'])

/** Launcher names an executable may carry on Windows, where `pi` is often a script shim. */
const LAUNCHER_EXTENSIONS = ['.exe', '.cmd', '.bat', '.ps1', '.sh', '.js']

export function agentTrustLaunchArgs(agent: unknown): readonly string[] {
  return typeof agent === 'string' && Object.hasOwn(TRUST_ARGS_BY_AGENT, agent)
    ? TRUST_ARGS_BY_AGENT[agent]
    : []
}

/** Splice the agent's trust args in after its executable, or return the command untouched. */
export function withAgentTrustLaunchArgs(
  command: string,
  agent: TuiAgent,
  shell: AgentStartupShell
): string {
  const trustArgs = agentTrustLaunchArgs(agent)
  if (trustArgs.length === 0) {
    return command
  }
  const { head, suffix } = splitDraftCleanupSuffix(command, agent, shell)
  const parsed = tokenizeStartupCommand(head, shell)
  if (!parsed.ok) {
    return command
  }
  // Why the head span alone: the args go immediately after the executable, so only the span being
  // spliced at has to be modelled faithfully — a prompt containing `&` or `>` is still safe to edit.
  const executableSpan = parsed.spans[0]
  if (!executableSpan || executableSpan.divergesFromShell) {
    return command
  }
  if (!isAgentExecutable(parsed.tokens[0], agent)) {
    return command
  }
  if (parsed.tokens.some((token) => TRUST_DECISION_FLAGS.has(token))) {
    return command
  }
  return `${head.slice(0, executableSpan.end)} ${trustArgs.join(' ')}${head.slice(executableSpan.end)}${suffix}`
}

/**
 * A draft launch trails its command with the cleanup for the env var that carried the draft
 * (`pi; <clear ORCA_PI_PREFILL>`), and its separators make every span read as diverging.
 */
function splitDraftCleanupSuffix(
  command: string,
  agent: TuiAgent,
  shell: AgentStartupShell
): { head: string; suffix: string } {
  const draftEnv = TUI_AGENT_CONFIG[agent].draftPromptEnvVar
  if (!draftEnv) {
    return { head: command, suffix: '' }
  }
  const suffix = `${commandSeparator(shell)}${clearEnvCommand(draftEnv, shell)}`
  return command.endsWith(suffix)
    ? { head: command.slice(0, command.length - suffix.length), suffix }
    : { head: command, suffix: '' }
}

/** A wrapper or an env prefix is not the agent itself, so it keeps whatever trust flow it has. */
function isAgentExecutable(token: string | undefined, agent: TuiAgent): boolean {
  if (!token) {
    return false
  }
  const executable = getCommandTokenPathBasename(token).toLowerCase()
  const launch = getCommandTokenPathBasename(
    getFirstCommandToken(TUI_AGENT_CONFIG[agent].launchCmd)
  ).toLowerCase()
  return (
    executable === launch ||
    LAUNCHER_EXTENSIONS.some((extension) => executable === launch + extension)
  )
}
