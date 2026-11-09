import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ProviderRateLimits } from '../../../shared/rate-limit-types'
import type { ClaudeEnvPatch } from '../../claude-accounts/environment'
import { buildClaudeChildProcessEnv } from '../../claude/claude-child-process-environment'
import { createClaudeCodeProcessSpawn } from '../../claude/claude-agent-sdk-process-spawn'
import { loadClaudeAgentSdk } from '../../claude/claude-stream-json-connection'
import { resolveClaudeCommand } from '../../codex-cli/command'
import { resolveHiddenProbeCwd } from '../hidden-probe-cwd'
import { mapClaudeCliRateLimitInfo, mapClaudeCliUsageResponse } from './claude-cli-usage-response'

/**
 * A probe turn measured 3.9 s end to end through Orca's spawn hook; the cap only bounds a wedged CLI.
 */
export const CLAUDE_CLI_USAGE_PROBE_TIMEOUT_MS = 15_000
/**
 * Cheapest model with a minimal reply: the reading is the CLI's own rate-limit event, not the answer.
 * Why the CLI alias and not a dated id: a retired id would make every poll stall to the deadline.
 */
export const CLAUDE_CLI_USAGE_PROBE_MODEL = 'haiku'
/** The smallest prompt that makes the CLI complete one turn, which is when it reports its limits. */
const PROBE_TURN_PROMPT = 'hi'

export type ClaudeUsageProbeOutcome =
  | { status: 'ok'; response: unknown }
  | { status: 'ok-rate-limit-info'; rateLimitInfo: unknown }
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

/**
 * The CLI's input for a probe: one prompt, then park forever.
 *
 * Why park rather than end: an ended stream closes the session, and the session is what publishes the
 * rate-limit event the reading comes from.
 */
const probeTurnInput: AsyncIterable<SDKUserMessage> = {
  [Symbol.asyncIterator]: () => {
    let sent = false
    return {
      next: async () => {
        if (sent) {
          return new Promise<IteratorResult<SDKUserMessage>>(() => {})
        }
        sent = true
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the CLI's own user-message envelope; the SDK types fields this probe does not set as required.
        const value = {
          type: 'user',
          message: { role: 'user', content: PROBE_TURN_PROMPT }
        } as SDKUserMessage
        return { value, done: false }
      }
    }
  }
}

/**
 * Read the CLI's own plan limits without asking the usage endpoint.
 *
 * One minimal turn makes the CLI learn its limits from its own API reply, and the CLI publishes them
 * as a `rate_limit_event` on the same stream.
 */
async function runUsageViaSdk(
  request: ClaudeUsageProbeProcess,
  timeoutMs: number
): Promise<ClaudeUsageProbeOutcome> {
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
  // Why: the session is created inside the guarded block so a failed start still clears the
  // deadline and the cycle's abort listener.
  let session: Query | null = null
  try {
    session = query({
      prompt: probeTurnInput,
      options: {
        pathToClaudeCodeExecutable: request.command,
        cwd: request.cwd,
        env: request.env,
        model: CLAUDE_CLI_USAGE_PROBE_MODEL,
        // Isolate the probe from a workspace's hooks, plugins and statusline.
        settingSources: [],
        // A probe must never start a saved MCP server, and it leaves no session behind.
        strictMcpConfig: true,
        persistSession: false,
        permissionMode: 'plan',
        spawnClaudeCodeProcess: spawner.spawn,
        abortController: deadline
      }
    })
    // Why a turn and not `get_usage`: that control request answers `rate_limits_available: false` on
    // 2.1.319, and issuing it first leaves the session unable to run the turn at all (measured: it
    // replies in 140 ms, then the stream stalls until the deadline).
    for await (const message of session) {
      if (message.type === 'rate_limit_event') {
        return { status: 'ok-rate-limit-info', rateLimitInfo: message.rate_limit_info }
      }
      // Why stop here: a turn that ends without the event (a 401, an API-key login, a dead model,
      // no network) will never publish one, so waiting out the deadline only stalls the poll.
      if (message.type === 'result') {
        break
      }
    }
    return { status: 'unavailable', reason: 'the CLI reported no rate limit event' }
  } catch (error) {
    if (request.signal?.aborted) {
      return { status: 'aborted' }
    }
    return {
      status: 'unavailable',
      reason: error instanceof Error ? error.message : String(error)
    }
  } finally {
    clearTimeout(timer)
    request.signal?.removeEventListener('abort', forwardAbort)
    // Why guarded: close() ends the session cleanly and abort() reaps a CLI that stopped reading
    // stdin, and neither may replace a good reading by throwing out of the cleanup.
    try {
      session?.close()
    } catch {
      // A session that already died has nothing left to close.
    }
    deadline.abort()
  }
}

const defaultDeps: ClaudeUsageProbeDeps = {
  resolveCommand: () => resolveClaudeCommand(),
  resolveCwd: () => resolveHiddenProbeCwd(),
  buildEnv: (patch) => buildClaudeChildProcessEnv({ ...patch }),
  runUsageControl: (request, timeoutMs) => runUsageViaSdk(request, timeoutMs)
}

/**
 * Ask the installed Claude CLI for the account's plan usage.
 *
 * This is the source that works while the usage endpoint rate-limits Orca: the CLI reports the same
 * windows from its own session, so the Claude app makes the call and Orca only reads what it says.
 * The caller only asks for that turn when the endpoint cannot answer.
 */
export async function probeClaudeUsage(
  input: { envPatch?: ClaudeEnvPatch; oauthToken?: string | null; signal?: AbortSignal } = {},
  deps: ClaudeUsageProbeDeps = defaultDeps
): Promise<ClaudeUsageProbeOutcome> {
  if (input.signal?.aborted) {
    return { status: 'aborted' }
  }
  try {
    // Why the token is set here: the probe isolates itself with `settingSources: []`, so a login kept
    // in the CLI's settings env would otherwise never reach the child, and an unauthenticated CLI
    // cannot report plan limits at all. Orca's child env strips inherited auth on purpose.
    const env = deps.buildEnv(input.envPatch ?? {})
    if (input.oauthToken) {
      env.CLAUDE_CODE_OAUTH_TOKEN = input.oauthToken
    }
    const outcome = await deps.runUsageControl(
      {
        command: deps.resolveCommand(),
        cwd: deps.resolveCwd(),
        env,
        ...(input.signal ? { signal: input.signal } : {})
      },
      CLAUDE_CLI_USAGE_PROBE_TIMEOUT_MS
    )
    if (input.signal?.aborted) {
      return { status: 'aborted' }
    }
    if (outcome === null || outcome === undefined) {
      return { status: 'unavailable', reason: 'the CLI answered no usage payload' }
    }
    if (isProbeOutcome(outcome)) {
      return outcome
    }
    return { status: 'ok', response: outcome }
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

function isProbeOutcome(value: unknown): value is ClaudeUsageProbeOutcome {
  if (typeof value !== 'object' || value === null || !('status' in value)) {
    return false
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: guarded by the `'status' in value` check above.
  const status = (value as { status?: unknown }).status
  return (
    status === 'ok' ||
    status === 'ok-rate-limit-info' ||
    status === 'unavailable' ||
    status === 'aborted'
  )
}

// The mapping runs outside probeClaudeUsage's try, so an unforeseen payload shape must not escape
// into the poll that would then lose its endpoint fallback.
function mapClaudeCliOutcomeSafely(outcome: ClaudeUsageProbeOutcome): ProviderRateLimits | null {
  if (outcome.status === 'ok') {
    try {
      return mapClaudeCliUsageResponse(outcome.response)
    } catch (error) {
      console.debug('[rate-limits] claude CLI usage payload was not readable:', error)
      return null
    }
  }
  if (outcome.status === 'ok-rate-limit-info') {
    try {
      return mapClaudeCliRateLimitInfo(outcome.rateLimitInfo)
    } catch (error) {
      console.debug('[rate-limits] claude CLI rate limit event was not readable:', error)
      return null
    }
  }
  return null
}

/** Probe the CLI and map what it reports, or null when this account cannot be read that way. */
export async function readClaudeUsageFromCli(
  input: { envPatch?: ClaudeEnvPatch; oauthToken?: string | null; signal?: AbortSignal } = {},
  deps: ClaudeUsageProbeDeps = defaultDeps
): Promise<ProviderRateLimits | null> {
  const outcome = await probeClaudeUsage(input, deps)
  if (outcome.status !== 'ok' && outcome.status !== 'ok-rate-limit-info') {
    if (outcome.status === 'unavailable') {
      console.debug('[rate-limits] claude CLI usage probe unavailable:', outcome.reason)
    }
    return null
  }
  const mapped = mapClaudeCliOutcomeSafely(outcome)
  if (!mapped) {
    console.debug('[rate-limits] claude CLI usage probe reported no plan limits')
  }
  return mapped
}
