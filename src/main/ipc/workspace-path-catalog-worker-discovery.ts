import type { WorkspacePathSearchPathSet } from '../../shared/workspace-path-search-contract'
import type { WorkspacePathSearchInstrumentationEvent } from '../../shared/workspace-path-search-instrumentation'
import type { buildRgArgsForQuickOpen } from '../../shared/quick-open-filter'
import type {
  WorkspacePathCatalogDiscoveryOptions,
  WorkspacePathCatalogDiscoveryResult,
  WorkspacePathCatalogWorkerBuildScope,
  WorkspacePathCatalogWorkerBuildSink
} from './workspace-path-catalog-builder'
import { scanRipgrepPaths } from './quick-open-rg-path-scan'

export async function buildWorkspacePathCatalogInWorker(args: {
  authorizedRootPath: string
  excludePathPrefixes: readonly string[]
  localGitOptions: { wslDistro?: string }
  options: WorkspacePathCatalogDiscoveryOptions
  rgArgs: ReturnType<typeof buildRgArgsForQuickOpen>
  workerBuild: WorkspacePathCatalogWorkerBuildSink
  wslDistroForOutput?: string
}): Promise<WorkspacePathCatalogDiscoveryResult> {
  const secondScope: WorkspacePathSearchPathSet =
    args.options.firstScope === 'included' ? 'all' : 'included'
  let requestedScope: WorkspacePathCatalogWorkerBuildScope | null = null
  await args.workerBuild.begin()
  try {
    const firstStartedAt = performance.now()
    await scanScope(args.options.firstScope)
    emitEnumeration(args.options, performance.now() - firstStartedAt)
    requestedScope = await args.workerBuild.finishScope(args.options.firstScope)
    if (requestedScope.retainedBytes > 0) {
      args.options.onWorkerScopePublished?.(requestedScope)
    }
    if (requestedScope.retainedBytes === 0) {
      await args.workerBuild.abort(false).catch(() => undefined)
      return {
        catalog: null,
        degradationReason: mapDegradationReason(requestedScope.degradationReason) ?? 'over-budget'
      }
    }
    if (requestedScope.degradationReason) {
      return workerResult(requestedScope)
    }

    const secondStartedAt = performance.now()
    try {
      await scanScope(secondScope)
    } catch {
      if (args.options.signal?.aborted) {
        await args.workerBuild.abort(false).catch(() => undefined)
        throw new Error('Workspace path catalog discovery was cancelled')
      }
      await args.workerBuild.abort(true).catch(() => undefined)
      return workerResult(requestedScope, 'failed')
    }
    emitEnumeration(args.options, performance.now() - secondStartedAt)
    const completed = await args.workerBuild.finishScope(secondScope)
    if (completed.complete && !completed.degradationReason) {
      args.options.onWorkerScopePublished?.(completed)
      return workerResult(completed)
    }
    return workerResult(requestedScope, completed.degradationReason ?? 'over-budget')
  } catch {
    await args.workerBuild
      .abort(args.options.signal?.aborted !== true && requestedScope !== null)
      .catch(() => undefined)
    if (args.options.signal?.aborted) {
      throw new Error('Workspace path catalog discovery was cancelled')
    }
    if (requestedScope && requestedScope.retainedBytes > 0) {
      return workerResult(requestedScope, 'failed')
    }
    return { catalog: null, degradationReason: 'failed' }
  }

  async function scanScope(pathSet: WorkspacePathSearchPathSet): Promise<void> {
    await scanRipgrepPaths({
      args: pathSet === 'included' ? args.rgArgs.primary : args.rgArgs.ignoredPass,
      authorizedRootPath: args.authorizedRootPath,
      excludePathPrefixes: args.excludePathPrefixes,
      localGitOptions: args.localGitOptions,
      onPathBatch: (paths) => args.workerBuild.addBatch(pathSet, paths),
      batchSize: 256,
      batchByteLimit: 512 * 1024,
      timeoutMilliseconds: 10 * 60_000,
      signal: args.options.signal,
      wslDistroForOutput: args.wslDistroForOutput
    })
  }
}

function workerResult(
  result: WorkspacePathCatalogWorkerBuildScope,
  degradationReason = result.degradationReason
): WorkspacePathCatalogDiscoveryResult {
  const mappedReason = mapDegradationReason(degradationReason)
  return {
    catalog: null,
    workerGenerationId: result.generationId,
    workerRetainedBytes: result.retainedBytes,
    ...(result.storageMode ? { workerStorageMode: result.storageMode } : {}),
    ...(result.spillFileBytes === undefined ? {} : { workerSpillFileBytes: result.spillFileBytes }),
    ...(mappedReason ? { degradationReason: mappedReason } : {})
  }
}

function mapDegradationReason(
  reason: string | undefined
): 'over-budget' | 'failed' | 'spill-unavailable' | undefined {
  if (!reason) {
    return undefined
  }
  if (reason === 'over-budget' || reason === 'spill-unavailable') {
    return reason
  }
  return 'failed'
}

function emitEnumeration(
  options: WorkspacePathCatalogDiscoveryOptions,
  milliseconds: number
): void {
  const event: WorkspacePathSearchInstrumentationEvent = {
    kind: 'stage-timing',
    record: {
      correlationId: options.correlationId ?? 'workspace-path-catalog-build',
      stage: 'enumeration',
      duration: { milliseconds, clock: 'execution-host-monotonic' }
    }
  }
  options.onInstrumentation?.(event)
}
