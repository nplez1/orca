import type { Query } from '@anthropic-ai/claude-agent-sdk'
import type { ProviderRateLimits } from '../../../shared/rate-limit-types'
import type { ClaudeEnvPatch } from '../../claude-accounts/environment'
import { buildClaudeChildProcessEnv } from '../../claude/claude-child-process-environment'
import { createClaudeCodeProcessSpawn } from '../../claude/claude-agent-sdk-process-spawn'
import {
  ClaudeControlRequestError,
  runClaudeControl
} from '../../claude/claude-agent-sdk-control-requests'
import { loadClaudeAgentSdk } from '../../claude/claude-stream-json-connection'
import { resolveClaudeCommand } from '../../codex-cli/command'
import { resolveHiddenProbeCwd } from '../hidden-probe-cwd'
import { mapClaudeCliUsageResponse } from './claude-cli-usage-response'

/** A warm headless start answered in ~0.45 s; the cap only bounds a wedged CLI. */
export const CLAUDE_CLI_USAGE_PROBE_TIMEOUT_MS = 15_000

export type ClaudeUsageProbeOutcome =
  | { status: 'ok'; response: unknown }
  | { status: 'unavailable'; reason: string }
  | { status: 'aborted' }

export type ClaudeUsageProbeProcess = {
  command: string
  cwd: string
  env: Record<string, string>
  signal?: AbortSignal
}

export type ClaudeUsageProbeDeps = {
  resolveCommand: () => string
  resolveCwd: () => string
  buildEnv: (patch: ClaudeEnvPatch) => Record<string, string>
  runUsageControl: (request: ClaudeUsageProbeProcess, timeoutMs: number) => Promise<unknown>
}

// Why: the CLI answers control requests only while its session is open, and Orca sends no message,
// so the session's input is a turn that never arrives.
const pendingSessionInput: AsyncIterable<never> = {
  [Symbol.asyncIterator]: () => ({
    next: () => new Promise<IteratorResult<never>>(() => {})
  })
}

// `request` exists at runtime but is absent from the SDK's Query declaration and its typed wrapper
// is named EXPERIMENTAL; the control request itself is the CLI's own stable protocol.
type ClaudeQueryControlRequester = {
  request?: (request: Record<string, unknown>) => Promise<{ response?: unknown } | undefined>
}

function claudeQueryControlRequester(
  session: Query
): ((request: Record<string, unknown>) => Promise<{ response?: unknown } | undefined>) | null {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only reads an optional method and checks its type before calling it.
  const request = (session as unknown as ClaudeQueryControlRequester).request
  return typeof request === 'function' ? request.bind(session) : null
}

/** The free path to plan usage: the CLI's own `/usage` data, read without spending a turn. */
async function runUsageControlViaSdk(
  request: ClaudeUsageProbeProcess,
  timeoutMs: number
): Promise<unknown> {
  const { query } = await loadClaudeAgentSdk()
  // Orca's own spawn hook: the same quoting and ownership every other Claude child gets.
  const spawner = createClaudeCodeProcessSpawn(undefined, process.platform, {
    pathToClaudeCodeExecutable: request.command
  })
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), timeoutMs)
  const forwardAbort = (): void => deadline.abort()
  request.signal?.addEventListener('abort', forwardAbort, { once: true })
  if (request.signal?.aborted) {
    deadline.abort()
  }
  const session = query({
    prompt: pendingSessionInput,
    options: {
      pathToClaudeCodeExecutable: request.command,
      cwd: request.cwd,
      env: request.env,
      // Isolate the probe from a workspace's hooks, plugins and statusline.
      settingSources: [],
      permissionMode: 'plan',
      spawnClaudeCodeProcess: spawner.spawn,
      abortController: deadline
    }
  })
  try {
    const send = claudeQueryControlRequester(session)
    if (!send) {
      throw new ClaudeControlRequestError('get_usage', 'this Claude CLI exposes no control request')
    }
    const envelope = await runClaudeControl(
      'get_usage',
      () => send({ subtype: 'get_usage', skip_behaviors: true }),
      timeoutMs
    )
    return envelope?.response ?? null
  } finally {
    clearTimeout(timer)
    request.signal?.removeEventListener('abort', forwardAbort)
    // Why both: close() ends the session cleanly, abort() reaps a CLI that stopped reading stdin.
    session.close()
    deadline.abort()
  }
}

const defaultDeps: ClaudeUsageProbeDeps = {
  resolveCommand: () => resolveClaudeCommand(),
  resolveCwd: () => resolveHiddenProbeCwd(),
  buildEnv: (patch) => buildClaudeChildProcessEnv({ ...patch }),
  runUsageControl: runUsageControlViaSdk
}

/**
 * Ask the installed Claude CLI for the account's plan usage.
 *
 * This is the source that works while the usage endpoint rate-limits Orca: the CLI reports the
 * same windows from its own session, and a probe spends no tokens, quota or conversation.
 */
export async function probeClaudeUsage(
  input: { envPatch?: ClaudeEnvPatch; signal?: AbortSignal } = {},
  deps: ClaudeUsageProbeDeps = defaultDeps
): Promise<ClaudeUsageProbeOutcome> {
  if (input.signal?.aborted) {
    return { status: 'aborted' }
  }
  try {
    const response = await deps.runUsageControl(
      {
        command: deps.resolveCommand(),
        cwd: deps.resolveCwd(),
        env: deps.buildEnv(input.envPatch ?? {}),
        ...(input.signal ? { signal: input.signal } : {})
      },
      CLAUDE_CLI_USAGE_PROBE_TIMEOUT_MS
    )
    if (input.signal?.aborted) {
      return { status: 'aborted' }
    }
    return response === null || response === undefined
      ? { status: 'unavailable', reason: 'the CLI answered no usage payload' }
      : { status: 'ok', response }
  } catch (error) {
    if (input.signal?.aborted) {
      return { status: 'aborted' }
    }
    return {
      status: 'unavailable',
      reason: error instanceof Error ? error.message : String(error)
    }
  }
}

/** Probe the CLI and map what it reports, or null when this account cannot be read that way. */
export async function readClaudeUsageFromCli(
  input: { envPatch?: ClaudeEnvPatch; signal?: AbortSignal } = {},
  deps: ClaudeUsageProbeDeps = defaultDeps
): Promise<ProviderRateLimits | null> {
  const outcome = await probeClaudeUsage(input, deps)
  if (outcome.status !== 'ok') {
    if (outcome.status === 'unavailable') {
      console.debug('[rate-limits] claude CLI usage probe unavailable:', outcome.reason)
    }
    return null
  }
  const mapped = mapClaudeCliUsageResponse(outcome.response)
  if (!mapped) {
    console.debug('[rate-limits] claude CLI usage probe reported no plan limits')
  }
  return mapped
}
