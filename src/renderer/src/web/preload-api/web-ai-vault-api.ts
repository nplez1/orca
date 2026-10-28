import {
  createSessionSearchClient,
  unavailableSessionSearchStatus
} from '../../../../shared/ai-vault-search-client'
import type { PreloadApi } from '../../../../preload/api-types'
import type {
  AiVaultPrepareSessionResumeRequest,
  AiVaultPrepareSessionResumeResult
} from '../../../../shared/ai-vault-resume-preparation'
import type { AiVaultDeleteSessionArgs } from '../../../../shared/ai-vault-session-deletion'
import type {
  AiVaultSessionTitlesArgs,
  AiVaultSessionTitlesResult
} from '../../../../shared/ai-vault-session-title'
import type { AiVaultListArgs, AiVaultListResult } from '../../../../shared/ai-vault-types'
import { aiVaultAppliedScopePaths } from '../../../../shared/ai-vault-session-depth'
import {
  aiVaultPartialListIssue,
  readAiVaultListPages
} from '../../../../shared/ai-vault-list-pages'
import {
  normalizeExecutionHostId,
  normalizeExecutionHostScope,
  toRuntimeExecutionHostId
} from '../../../../shared/execution-host'
import type { ExecutionHostId, ExecutionHostScope } from '../../../../shared/execution-host'
import {
  assertEnvironmentPairing,
  callRuntimeEnvelope,
  callRuntimeResult
} from './web-runtime-calls'
import {
  applyHeldBrowserAiVaultDelta,
  browserHeldAiVaultList,
  rememberBrowserAiVaultList,
  reusedBrowserAiVaultList
} from './web-ai-vault-list-sync'
import {
  readRuntimeAiVaultDeleteSessionResponse,
  runtimeAiVaultDeleteSessionParams
} from '../../../../shared/ai-vault-runtime-session-delete'
import { requireActiveEnvironment } from './web-runtime-session'
import { noopUnsubscribe } from './web-storage'
import { translate } from '@/i18n/i18n'

/** One listing identity: the same host, scope, depth and opt-ins is the same list. */
function browserListKey(
  environmentId: string,
  args: AiVaultListArgs | undefined,
  requestedScope: ExecutionHostScope
): string {
  return JSON.stringify([
    environmentId,
    requestedScope,
    // Canonical like the desktop key: the same paths in another order are the same listing.
    [...new Set(args?.scopePaths ?? [])].sort(),
    args?.limit ?? null,
    args?.unlimited === true,
    args?.includeAntigravityIdeSessions === true
  ])
}

export function createWebAiVaultApi(): NonNullable<Partial<PreloadApi>['aiVault']> {
  const search = createSessionSearchClient(
    (method, params) => callRuntimeResult(method, params),
    'relay'
  )
  return {
    // A browser searches only its selected paired runtime.
    searchSessions: (request, executionHostScope) =>
      addressesOwnRuntime(executionHostScope)
        ? search.searchSessions(request)
        : Promise.resolve({ kind: 'unavailable', reason: 'no-service' }),
    searchStatus: (executionHostScope) =>
      addressesOwnRuntime(executionHostScope)
        ? search.searchStatus()
        : Promise.resolve(unavailableSessionSearchStatus()),
    // Host-index consent requires the desktop operator’s settings surface.
    setSearchEnabled: () => Promise.reject(new Error('unsupported')),
    clearSearchIndex: () =>
      Promise.reject(new Error('Clearing Agent Session History is unavailable in the browser.')),
    listSessions: async (args?: AiVaultListArgs) => {
      const environment = requireActiveEnvironment()
      const executionHostId = toRuntimeExecutionHostId(environment.id)
      const requestedScope = normalizeExecutionHostScope(
        args?.executionHostScope ?? executionHostId
      )
      if (requestedScope !== 'all' && requestedScope !== executionHostId) {
        return webAiVaultUnavailableResult(requestedScope)
      }
      const listKey = browserListKey(environment.id, args, requestedScope)
      const held = browserHeldAiVaultList(listKey)
      const hostPairingRevision = environment.pairingRevision ?? environment.createdAt
      // Fence later host mutations on these rows to the pairing that listed them.
      const withHostPairingRevision = (result: AiVaultListResult): AiVaultListResult =>
        result.sessions
          ? {
              ...result,
              sessions: result.sessions.map((session) => ({ ...session, hostPairingRevision }))
            }
          : result
      // Why: no local filesystem in the browser, so every history scan runs on and is stamped as
      // the paired runtime host. The reply is drained page by page because the paired connection
      // refuses any frame over 4 MiB, and a refresh asks for only the rows that changed.
      const read = await readAiVaultListPages({
        firstPageArgs: {
          includeAntigravityIdeSessions: args?.includeAntigravityIdeSessions,
          limit: args?.limit,
          // Why: the host applies the depth, so a browser that drops it here serves the host's
          // default cap however the panel's depth is set.
          unlimited: args?.unlimited,
          force: args?.force,
          ...(requestedScope === executionHostId && args?.afterFingerprint !== undefined
            ? { afterFingerprint: args.afterFingerprint }
            : {}),
          ...(held ? { syncFromFingerprint: held.fingerprint } : {}),
          scopePaths: aiVaultAppliedScopePaths(args)
        },
        fetchPage: (pageArgs) =>
          callRuntimeResult<AiVaultListResult>('aiVault.listSessions', {
            ...pageArgs,
            executionHostId
          })
      })
      // Why the held list survives a failed or partial read: it is still the list its fingerprint
      // names, so the next refresh can ask for the difference from it instead of the whole history.
      if (read.kind === 'failed') {
        throw read.error
      }
      if (read.kind === 'partial') {
        return withHostPairingRevision({
          ...read.result,
          issues: [
            ...read.result.issues,
            aiVaultPartialListIssue({
              executionHostId,
              path: environment.id,
              error: read.error
            })
          ]
        })
      }
      if (read.result.unchanged) {
        // Why pass it through when the held list names a different body: the renderer treats
        // `unchanged` as "ask again for the body", and relabelling a list with a fingerprint it
        // does not match would break the next diff. The held list stays: it is still valid at its
        // own fingerprint.
        if (!held || held.fingerprint !== read.result.fingerprint) {
          return withHostPairingRevision(read.result)
        }
        const reused = reusedBrowserAiVaultList(held, read.result)
        rememberBrowserAiVaultList(listKey, reused)
        return withHostPairingRevision(reused)
      }
      if (read.result.syncDelta) {
        if (!held) {
          throw new Error('The host answered with changes to a list this client does not hold.')
        }
        const rebuilt = applyHeldBrowserAiVaultDelta(held, read.result)
        rememberBrowserAiVaultList(listKey, rebuilt)
        return withHostPairingRevision(rebuilt)
      }
      rememberBrowserAiVaultList(listKey, read.result)
      return withHostPairingRevision(read.result)
    },
    resolveSessionTitles: (args: AiVaultSessionTitlesArgs) => {
      const environment = requireActiveEnvironment()
      const executionHostId = toRuntimeExecutionHostId(environment.id)
      if (
        args.executionHostScope &&
        normalizeExecutionHostScope(args.executionHostScope) !== executionHostId
      ) {
        return Promise.resolve({ titles: [] })
      }
      return callRuntimeResult<AiVaultSessionTitlesResult>('aiVault.resolveSessionTitles', {
        requests: args.requests
      }).catch(() => ({ titles: [] }))
    },
    // No RPC cancel verb; refreshId drops late results, but the unused scan runs until its timeout.
    cancelListSessions: () => Promise.resolve(),
    prepareSessionResume: (args: AiVaultPrepareSessionResumeRequest) =>
      callRuntimeResult<AiVaultPrepareSessionResumeResult>('aiVault.prepareSessionResume', args),
    // Why: no server-side RPC for subagent transcript listing yet, so report an empty (not erroring) result.
    listSubagentSessions: () => Promise.resolve({ sessions: [], issues: [] }),
    // Why: full first-prompt re-parse is local-FS only; web/runtime falls back to preview text.
    getFirstUserPrompt: () => Promise.resolve({ prompt: null }),
    // A browser can delete only on its own paired runtime, which validates the path itself.
    deleteSession: async (args: AiVaultDeleteSessionArgs) => {
      if (!addressesOwnRuntime(args.executionHostId)) {
        return { outcome: 'rejected', agent: args.agent, reason: 'non-local-host' }
      }
      assertEnvironmentPairing(
        requireActiveEnvironment().id,
        args.expectedEnvironmentPairingRevision
      )
      return readRuntimeAiVaultDeleteSessionResponse(
        await callRuntimeEnvelope('aiVault.deleteSession', runtimeAiVaultDeleteSessionParams(args)),
        args.agent
      )
    },
    onWindowFocused: () => noopUnsubscribe,
    // Why: the runtime RPC has no progress stream, so the panel keeps its plain spinner here.
    getScanProgress: () => Promise.resolve(null),
    onScanProgress: () => noopUnsubscribe
  }
}

// Malformed scopes must not become everything; all is a desktop merge and cannot address this browser’s runtime.
function addressesOwnRuntime(executionHostScope: ExecutionHostScope | undefined): boolean {
  const ownRuntimeId = toRuntimeExecutionHostId(requireActiveEnvironment().id)
  return (
    executionHostScope === undefined ||
    normalizeExecutionHostId(executionHostScope) === ownRuntimeId
  )
}

export function webAiVaultUnavailableResult(executionHostId: ExecutionHostId): AiVaultListResult {
  return {
    sessions: [],
    issues: [
      {
        executionHostId,
        agent: 'codex',
        path: executionHostId,
        message: translate(
          'auto.web.webPreloadApi.aiVaultUnavailableForHost',
          'Agent Session History is not available for this execution host.'
        )
      }
    ],
    scannedAt: new Date().toISOString()
  }
}
