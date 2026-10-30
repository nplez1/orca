/* eslint-disable max-lines -- Why: upstream's session scanner plus the fork's paged drain, row-cap
   prune and pairing-revision fencing, which cannot move out without copying upstream's scan body. */
import { aiVaultScanIssueText } from '../../shared/ai-vault-scan-issue-copy'
import { AiVaultChatForkSourceSchema } from '../../shared/ai-vault-chat-fork-contract'
import { z } from 'zod'
import {
  AI_VAULT_AGENTS,
  AI_VAULT_SCOPE_PATHS_MAX_COUNT,
  isAiVaultScanCancelledError,
  type AiVaultListArgs,
  type AiVaultListResult,
  type AiVaultSession
} from '../../shared/ai-vault-types'
import { toRuntimeExecutionHostId } from '../../shared/execution-host'
import { listEnvironments, resolveEnvironment } from '../../shared/runtime-environment-store'
import { callRuntimeEnvironment } from '../ipc/runtime-environments/runtime-environment-transport-routing'
import type {
  AiVaultPrepareSessionResumeRequest,
  AiVaultPrepareSessionResumeResult
} from '../../shared/ai-vault-resume-preparation'
import type {
  AiVaultSessionTitlesArgs,
  AiVaultSessionTitlesResult
} from '../../shared/ai-vault-session-title'
import { parseAiVaultListResult } from './session-list-result-validation'
import { aiVaultPartialListIssue, readAiVaultListPages } from '../../shared/ai-vault-list-pages'
import { parseAiVaultSessionTitlesResult } from './session-title-result-validation'
import { isGatedOffWslHost } from '../wsl/wsl-host-gate'
import type {
  AiVaultDeleteSessionArgs,
  AiVaultDeleteSessionResult
} from '../../shared/ai-vault-session-deletion'
import {
  readRuntimeAiVaultDeleteSessionResponse,
  runtimeAiVaultDeleteSessionParams
} from '../../shared/ai-vault-runtime-session-delete'
import type { RuntimeAiVaultHostInfo } from '../ipc/ai-vault-runtime-scan'

export type RuntimeAiVaultScanOptions = {
  /** One page's request bound. */
  timeoutMs?: number
  /** The whole drain's bound, so a paged listing gets more than one reply's worth of time. */
  drainTimeoutMs?: number
  /** Stops the page drain when the caller cancels; each page request carries it too. */
  signal?: AbortSignal
}

// Zod strips undeclared keys; keep the repinned home so resume uses the correct account.
const aiVaultPrepareSessionResumeResultSchema = z.object({
  useRealCodexHome: z.boolean(),
  cliForkSource: AiVaultChatForkSourceSchema.optional(),
  substituteCodexHome: z.string().optional(),
  forkedSession: z
    .object({
      sessionId: z.string(),
      agent: z.enum(AI_VAULT_AGENTS),
      filePath: z.string().optional()
    })
    .optional()
})

export function getSavedRuntimeAiVaultHostInfos(
  userDataPath: string
): readonly RuntimeAiVaultHostInfo[] {
  return listEnvironments(userDataPath)
    .filter((environment) => !isGatedOffWslHost(environment))
    .map((environment) => ({
      environmentId: environment.id,
      executionHostId: toRuntimeExecutionHostId(environment.id),
      ...(environment.connectionDependency
        ? { connectionDependency: environment.connectionDependency }
        : {})
    }))
}

export async function scanRuntimeAiVaultSessions(
  userDataPath: string,
  environmentId: string,
  args: AiVaultListArgs,
  options: RuntimeAiVaultScanOptions = {}
): Promise<AiVaultListResult> {
  const executionHostId = toRuntimeExecutionHostId(environmentId)
  const drainBudget = drainBudgetMs(options)
  // Captured before the call: a re-pair mid-scan leaves rows fenced to the older pairing, never the newer.
  const pairingRevision = savedPairingRevision(userDataPath, environmentId)
  // Why drain here: a remote reply is capped at one 4 MiB frame, so a host's thousands of rows
  // arrive as byte-bounded pages and every desktop reader still sees one complete list.
  const read = await readAiVaultListPages({
    firstPageArgs: args,
    fetchPage: (pageArgs) =>
      fetchRuntimeAiVaultListPage(userDataPath, environmentId, pageArgs, options),
    ...(options.signal ? { signal: options.signal } : {}),
    // Why the drain budget wins over the per-page one: the timeout bounded one reply before
    // paging, and an 'all'-scope leg must not hold the merge open for pages × timeout.
    ...(drainBudget !== undefined ? { deadlineMs: Date.now() + drainBudget } : {})
  })
  if (read.kind === 'failed') {
    return runtimeScanIssueResult({
      executionHostId,
      environmentId,
      message: errorMessage(read.error)
    })
  }
  if (read.result.unchanged) {
    return read.result
  }
  const result = withRuntimeExecutionHost(read.result, executionHostId, pairingRevision)
  const issues = [...result.issues]
  // Why not for a cancelled read: the caller left, so an "only part loaded" row would report its
  // own cancellation as a failure. Its rows are dropped by that caller in any case.
  if (read.kind === 'partial' && !isAiVaultScanCancelledError(read.error)) {
    // Why: the rows already read stay on screen; only the rest is missing, and Refresh retries it.
    issues.push(
      aiVaultPartialListIssue({ executionHostId, path: environmentId, error: read.error })
    )
  }
  if (args.scopePaths && args.scopePaths.length > AI_VAULT_SCOPE_PATHS_MAX_COUNT) {
    issues.push({
      executionHostId,
      agent: 'codex',
      kind: 'scope',
      path: environmentId,
      ...aiVaultScanIssueText('scopePathsTruncated', {
        params: { limit: AI_VAULT_SCOPE_PATHS_MAX_COUNT }
      })
    })
  }
  return issues.length === result.issues.length ? result : { ...result, issues }
}

async function fetchRuntimeAiVaultListPage(
  userDataPath: string,
  environmentId: string,
  args: AiVaultListArgs,
  options: RuntimeAiVaultScanOptions
): Promise<AiVaultListResult> {
  const response = await callHostListPage(
    userDataPath,
    environmentId,
    runtimeListPageParams(args, toRuntimeExecutionHostId(environmentId)),
    options
  )
  if (response.ok !== true) {
    throw new Error(response.error.message)
  }
  try {
    const parsed = parseAiVaultListResult(response.result, { offset: args.offset })
    if (parsed.unchanged && parsed.fingerprint !== args.afterFingerprint) {
      throw new Error('Unchanged response did not match the requested fingerprint')
    }
    // Why refuse: a delta this request never asked for names no list to apply it to.
    if (parsed.syncDelta && args.syncFromFingerprint === undefined) {
      throw new Error('Unexpected session delta')
    }
    return parsed
  } catch (error) {
    throw new Error(
      `Invalid aiVault.listSessions response: ${
        error instanceof Error ? error.message : 'unexpected result shape'
      }`
    )
  }
}

/**
 * Why the transport's option slot only when there is a signal: a cancelled listing must stop the
 * page in flight, or the host keeps re-projecting pages nobody will read, and the positional
 * arguments other callers already rely on stay as they are.
 */
function callHostListPage(
  userDataPath: string,
  environmentId: string,
  params: Record<string, unknown>,
  options: RuntimeAiVaultScanOptions
): ReturnType<typeof callRuntimeEnvironment> {
  return options.signal
    ? callRuntimeEnvironment(
        userDataPath,
        environmentId,
        'aiVault.listSessions',
        params,
        options.timeoutMs,
        undefined,
        undefined,
        { signal: options.signal }
      )
    : callRuntimeEnvironment(
        userDataPath,
        environmentId,
        'aiVault.listSessions',
        params,
        options.timeoutMs
      )
}

function drainBudgetMs(options: RuntimeAiVaultScanOptions): number | undefined {
  return options.drainTimeoutMs ?? options.timeoutMs
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Remote Orca server is unavailable.'
}

function runtimeListPageParams(
  args: AiVaultListArgs,
  executionHostId: `runtime:${string}`
): Record<string, unknown> {
  return {
    includeAntigravityIdeSessions: args.includeAntigravityIdeSessions,
    limit: args.limit,
    unlimited: args.unlimited,
    force: args.force,
    ...(args.afterFingerprint !== undefined ? { afterFingerprint: args.afterFingerprint } : {}),
    ...(args.syncFromFingerprint !== undefined
      ? { syncFromFingerprint: args.syncFromFingerprint }
      : {}),
    // Why: cap here so the set of scanned paths is explicit on this side —
    // the RPC schema CLAMPS to the same bound anyway (older hosts had no
    // cap). Dropped paths only lose the older-than-recency-cap guarantee,
    // never the recent sessions themselves.
    scopePaths: args.scopePaths?.slice(0, AI_VAULT_SCOPE_PATHS_MAX_COUNT),
    // A host that predates paging strips both keys and answers with one reply, as it always did.
    paged: true,
    offset: args.offset,
    executionHostId
  }
}

export async function resolveRuntimeAiVaultSessionTitles(
  userDataPath: string,
  environmentId: string,
  args: AiVaultSessionTitlesArgs
): Promise<AiVaultSessionTitlesResult> {
  const response = await callRuntimeEnvironment(
    userDataPath,
    environmentId,
    'aiVault.resolveSessionTitles',
    { requests: args.requests }
  )
  if (response.ok !== true) {
    return { titles: [] }
  }
  try {
    return parseAiVaultSessionTitlesResult(response.result)
  } catch {
    return { titles: [] }
  }
}

export async function prepareRuntimeAiVaultSessionResume(
  userDataPath: string,
  environmentId: string,
  args: AiVaultPrepareSessionResumeRequest
): Promise<AiVaultPrepareSessionResumeResult> {
  const response = await callRuntimeEnvironment(
    userDataPath,
    environmentId,
    'aiVault.prepareSessionResume',
    args
  )
  if (response.ok !== true) {
    if (
      response.error.code === 'method_not_found' &&
      response.error.message === 'Unknown method: aiVault.prepareSessionResume'
    ) {
      // Electron drops custom error fields; preserve this compatibility verdict in the message.
      throw new Error('aiVault.prepareSessionResume: method_not_found')
    }
    throw new Error(response.error.message)
  }
  const parsed = aiVaultPrepareSessionResumeResultSchema.safeParse(response.result)
  if (!parsed.success) {
    throw new Error(
      `Invalid aiVault.prepareSessionResume response: ${parsed.error.issues[0]?.message ?? 'unexpected result shape'}`
    )
  }
  return parsed.data
}

/** The owning host validates and deletes; a host without the RPC asks for an update instead. */
export async function deleteRuntimeAiVaultSession(
  userDataPath: string,
  environmentId: string,
  args: AiVaultDeleteSessionArgs
): Promise<AiVaultDeleteSessionResult> {
  const response = await callRuntimeEnvironment(
    userDataPath,
    environmentId,
    'aiVault.deleteSession',
    runtimeAiVaultDeleteSessionParams(args),
    undefined,
    args.expectedEnvironmentPairingRevision
  )
  return readRuntimeAiVaultDeleteSessionResponse(response, args.agent)
}

function savedPairingRevision(userDataPath: string, environmentId: string): number | undefined {
  try {
    const environment = resolveEnvironment(userDataPath, environmentId)
    return environment.pairingRevision ?? environment.createdAt
  } catch {
    return undefined
  }
}

function withRuntimeExecutionHost(
  result: AiVaultListResult,
  executionHostId: `runtime:${string}`,
  pairingRevision: number | undefined
): AiVaultListResult {
  return {
    sessions: result.sessions.map((session) =>
      retagRuntimeSession(session, executionHostId, pairingRevision)
    ),
    issues: result.issues.map((issue) => ({ ...issue, executionHostId })),
    scannedAt: result.scannedAt,
    ...(result.fingerprint ? { fingerprint: result.fingerprint } : {}),
    // Why retag upserts too: the delta is applied to a list this parent already stamped, so its
    // ids must be in this parent's spelling. Removed ids already are.
    ...(result.syncDelta
      ? {
          syncDelta: {
            upserts: result.syncDelta.upserts.map((session) =>
              retagRuntimeSession(session, executionHostId, pairingRevision)
            ),
            removedIds: result.syncDelta.removedIds
          }
        }
      : {})
  }
}

function retagRuntimeSession(
  session: AiVaultSession,
  executionHostId: `runtime:${string}`,
  pairingRevision: number | undefined
): AiVaultSession {
  // The caller selects the scanned host; a transport peer cannot supply trusted execution IDs or pairings.
  const { hostPairingRevision: _untrusted, ...rest } = session
  return {
    ...rest,
    executionHostId,
    id: `${executionHostId}:${session.agent}:${session.sessionId}:${session.filePath}`,
    ...(pairingRevision !== undefined ? { hostPairingRevision: pairingRevision } : {})
  }
}

function runtimeScanIssueResult(args: {
  executionHostId: `runtime:${string}`
  environmentId: string
  message: string
}): AiVaultListResult {
  return {
    sessions: [],
    issues: [
      {
        executionHostId: args.executionHostId,
        agent: 'codex',
        kind: 'host',
        path: args.environmentId,
        message: args.message
      }
    ],
    scannedAt: new Date().toISOString()
  }
}
