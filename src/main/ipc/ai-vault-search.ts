import { ipcMain } from 'electron'
import { z } from 'zod'
import {
  searchSessionService,
  sessionSearchServiceStatus
} from '../ai-vault-search/session-search-service-registry'
import {
  createSessionSearchClient,
  unavailableSessionSearchStatus
} from '../../shared/ai-vault-search-client'
import { AiVaultSearchRequestSchema } from '../../shared/ai-vault-search-contract'
import { SESSION_SEARCH_LIMIT_MAX } from '../../shared/ai-vault-search-limit'
import type {
  AiVaultSearchRequest,
  AiVaultSearchResponse,
  AiVaultSearchStatus
} from '../../shared/ai-vault-search-types'
import {
  ALL_EXECUTION_HOSTS_SCOPE,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ParsedExecutionHost
} from '../../shared/execution-host'
import { getActiveSshAiVaultHostInfos, requestActiveSshSessionSearch } from './ssh'
import type { RuntimeAiVaultHostInfo } from './ai-vault-runtime-scan'
import { searchAllExecutionHosts, type AiVaultSearchAllHostDeps } from './ai-vault-search-all-hosts'
import { searchAllExecutionHostsStatus } from './ai-vault-search-status-aggregation'

export type RuntimeSessionSearchCall = (
  environmentId: string,
  method: string,
  params: Record<string, unknown>
) => Promise<unknown>

export type AiVaultSearchHandlerOptions = {
  callRuntimeSearch?: RuntimeSessionSearchCall
  getActiveRuntimeAiVaultHostInfos?: () => readonly RuntimeAiVaultHostInfo[]
}

// One wording with the session list, which refuses the same unroutable scope.
const UNROUTABLE_HOST_MESSAGE = 'Agent Session History is not available for this execution host.'
const scopeSchema = z.string().min(1).optional()
// Why: `AiVaultSearchRequestSchema` clamps `limit` to the ceiling silently, so the
// pre-clamp number has to be read separately to report that clamp as truncation.
const requestedLimitSchema = z.object({ limit: z.number().optional() })

type AllHostsSearchScope = { kind: 'all'; id: typeof ALL_EXECUTION_HOSTS_SCOPE }
type SearchScope = ParsedExecutionHost | AllHostsSearchScope

let handlerOptions: AiVaultSearchHandlerOptions = {}

export function registerAiVaultSearchHandlers(options: AiVaultSearchHandlerOptions = {}): void {
  handlerOptions = options
  // Async so a refused scope reaches the renderer as a rejection, like every other parse failure.
  ipcMain.handle('aiVault:searchSessions', async (_event, raw: unknown, rawScope?: unknown) => {
    const scope = requestedSearchScope(rawScope)
    return searchByExecutionHostScope(AiVaultSearchRequestSchema.parse(raw), scope, {
      requestedDepthExceededCeiling: requestedSearchDepthExceededCeiling(raw)
    })
  })
  ipcMain.handle('aiVault:searchStatus', async (_event, rawScope?: unknown) => {
    const scope = requestedSearchScope(rawScope)
    return statusByExecutionHost(scope)
  })
}

/**
 * Why not the list's `requestedExecutionHostScope`: it normalizes an unparseable
 * id to `all`, which would answer an unroutable request by searching every host.
 * Same parser, same omitted-means-this-host rule, but garbage is refused.
 */
function requestedSearchScope(raw: unknown): SearchScope {
  const value = scopeSchema.parse(raw)
  if (value === undefined) {
    return { kind: 'local', id: LOCAL_EXECUTION_HOST_ID }
  }
  const parsed = parseExecutionHostId(value)
  if (parsed) {
    return parsed
  }
  if (value === ALL_EXECUTION_HOSTS_SCOPE) {
    return { kind: 'all', id: ALL_EXECUTION_HOSTS_SCOPE }
  }
  throw new Error(UNROUTABLE_HOST_MESSAGE)
}

/** The caller's limit is clamped to the per-host ceiling; say so instead of hiding it. */
function requestedSearchDepthExceededCeiling(raw: unknown): boolean {
  const requested = requestedLimitSchema.safeParse(raw).data?.limit
  return typeof requested === 'number' && requested > SESSION_SEARCH_LIMIT_MAX
}

async function searchByExecutionHostScope(
  request: AiVaultSearchRequest,
  scope: SearchScope,
  options: { requestedDepthExceededCeiling: boolean }
): Promise<AiVaultSearchResponse> {
  if (scope.kind === 'all') {
    return searchAllExecutionHosts({ ...options, request, deps: allHostSearchDeps() })
  }
  if (scope.kind === 'local') {
    return searchSessionService(request, 'ipc')
  }
  const client = remoteSearchClient(scope, handlerOptions.callRuntimeSearch)
  if (!client) {
    return { kind: 'unavailable', reason: 'no-service' }
  }
  const response = await client.searchSessions(request)
  // This desktop owns which remote host was addressed.
  return response.kind === 'results'
    ? { ...response, hits: response.hits.map((hit) => ({ ...hit, executionHostId: scope.id })) }
    : response
}

function statusByExecutionHost(scope: SearchScope): Promise<AiVaultSearchStatus> {
  if (scope.kind === 'all') {
    return searchAllExecutionHostsStatus(allHostSearchDeps())
  }
  if (scope.kind === 'local') {
    return sessionSearchServiceStatus({}, 'ipc')
  }
  const client = remoteSearchClient(scope, handlerOptions.callRuntimeSearch)
  return client ? client.searchStatus() : Promise.resolve(unavailableSessionSearchStatus())
}

// One description of every reachable host, shared by the merged search and the
// aggregate status so the two can never enumerate different host sets.
function allHostSearchDeps(): AiVaultSearchAllHostDeps {
  return {
    localClient: {
      searchSessions: (request) => searchSessionService(request, 'ipc'),
      searchStatus: () => sessionSearchServiceStatus({}, 'ipc')
    },
    discoverSshHosts: getActiveSshAiVaultHostInfos,
    sshClient: (targetId) =>
      createSessionSearchClient(
        (method, params) => requestActiveSshSessionSearch(targetId, method, params),
        'relay'
      ),
    discoverRuntimeHosts: () => handlerOptions.getActiveRuntimeAiVaultHostInfos?.() ?? [],
    runtimeClient: (environmentId) =>
      remoteSearchClient(
        {
          kind: 'runtime',
          id: toRuntimeExecutionHostId(environmentId),
          environmentId
        },
        handlerOptions.callRuntimeSearch
      )
  }
}

// Null for the local host and for a runtime environment with no injected transport.
function remoteSearchClient(
  host: ParsedExecutionHost,
  call: RuntimeSessionSearchCall | undefined
): ReturnType<typeof createSessionSearchClient> | null {
  if (host.kind === 'ssh') {
    const { targetId } = host
    return createSessionSearchClient(
      (method, params) => requestActiveSshSessionSearch(targetId, method, params),
      'relay'
    )
  }
  if (host.kind === 'runtime' && call) {
    const { environmentId } = host
    return createSessionSearchClient(
      (method, params) => call(environmentId, method, params),
      'relay'
    )
  }
  return null
}
