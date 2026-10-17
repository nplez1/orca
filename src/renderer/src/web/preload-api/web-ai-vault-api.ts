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
import { callRuntimeResult } from './web-runtime-calls'
import {
  applyHeldBrowserAiVaultDelta,
  browserHeldAiVaultList,
  forgetBrowserAiVaultList,
  rememberBrowserAiVaultList,
  reusedBrowserAiVaultList
} from './web-ai-vault-list-sync'
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
    args?.scopePaths ?? [],
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
    // Why refused and not forwarded: consent for a host's index is an operator action,
    // and the browser client has no desktop settings surface to reconcile it against.
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
      // Why: no local filesystem in the browser, so every history scan runs on and is stamped as
      // the paired runtime host. The reply is drained page by page because the paired connection
      // refuses any frame over 4 MiB, and a refresh asks for only the rows that changed.
      const read = await readAiVaultListPages({
        firstPageArgs: {
          includeAntigravityIdeSessions: args?.includeAntigravityIdeSessions,
          limit: args?.limit,
          force: args?.force,
          ...(requestedScope === executionHostId && args?.afterFingerprint !== undefined
            ? { afterFingerprint: args.afterFingerprint }
            : {}),
          ...(held ? { syncFromFingerprint: held.fingerprint } : {}),
          scopePaths: args?.scopePaths
        },
        fetchPage: (pageArgs) =>
          callRuntimeResult<AiVaultListResult>('aiVault.listSessions', {
            ...pageArgs,
            executionHostId
          })
      })
      if (read.kind === 'failed') {
        forgetBrowserAiVaultList(listKey)
        throw read.error
      }
      if (read.kind === 'partial') {
        // The rows on screen stay usable; the held list is dropped so the next refresh is a full one.
        forgetBrowserAiVaultList(listKey)
        return {
          ...read.result,
          issues: [
            ...read.result.issues,
            aiVaultPartialListIssue({
              executionHostId,
              path: environment.id,
              error: read.error
            })
          ]
        }
      }
      if (read.result.unchanged) {
        // Why pass it through when the held list is gone: the renderer already treats `unchanged`
        // as "ask again for the body", and relabelling a different list with this fingerprint would
        // store a body under a fingerprint it does not match.
        if (!held || held.fingerprint !== read.result.fingerprint) {
          forgetBrowserAiVaultList(listKey)
          return read.result
        }
        const reused = reusedBrowserAiVaultList(held, read.result)
        rememberBrowserAiVaultList(listKey, reused)
        return reused
      }
      if (read.result.syncDelta) {
        if (!held) {
          forgetBrowserAiVaultList(listKey)
          throw new Error('The host answered with changes to a list this client does not hold.')
        }
        const rebuilt = applyHeldBrowserAiVaultDelta(held, read.result)
        rememberBrowserAiVaultList(listKey, rebuilt)
        return rebuilt
      }
      rememberBrowserAiVaultList(listKey, read.result)
      return read.result
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
    // Why: the runtime RPC transport has no cancel verb, so the in-flight scan
    // settles on its own timeout. The renderer's refreshId guard already drops
    // the late result; this only means web pays for a scan nobody reads.
    cancelListSessions: () => Promise.resolve(),
    prepareSessionResume: (args: AiVaultPrepareSessionResumeRequest) =>
      callRuntimeResult<AiVaultPrepareSessionResumeResult>('aiVault.prepareSessionResume', args),
    // Why: no server-side RPC for subagent transcript listing yet, so report an empty (not erroring) result.
    listSubagentSessions: () => Promise.resolve({ sessions: [], issues: [] }),
    // Why: full first-prompt re-parse is local-FS only; web/runtime falls back to preview text.
    getFirstUserPrompt: () => Promise.resolve({ prompt: null }),
    // Why: session deletion is local-only and has no runtime RPC; a web
    // client's sessions are runtime-hosted, so report the same non-local
    // rejection the UI already gates on rather than pretend to delete.
    deleteSession: (args: AiVaultDeleteSessionArgs) =>
      Promise.resolve({
        outcome: 'rejected',
        agent: args.agent,
        reason: 'non-local-host' as const
      }),
    onWindowFocused: () => noopUnsubscribe,
    // Why: the runtime RPC has no progress stream, so the panel keeps its plain spinner here.
    getScanProgress: () => Promise.resolve(null),
    onScanProgress: () => noopUnsubscribe
  }
}

// An unparseable id must not normalize into the everything-scope and answer anyway.
// `all` is a desktop-side merge; it never normalizes to this runtime, so a browser reports no-service.
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
