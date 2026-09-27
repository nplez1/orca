import { sep } from 'node:path'
import type { Store } from '../persistence'
import type {
  WorkspacePathSearchCorrelationId,
  WorkspacePathSearchInstrumentationEvent
} from '../../shared/workspace-path-search-instrumentation'
import type { WorkspacePathSearchPathSet } from '../../shared/workspace-path-search-contract'
import { buildExcludePathPrefixes, buildRgArgsForQuickOpen } from '../../shared/quick-open-filter'
import { WorkspacePathCatalogBuilder } from '../../shared/workspace-path-catalog-builder'
import {
  WorkspacePathCatalogOverlayBuilder,
  type WorkspacePathCatalogOverlay
} from '../../shared/workspace-path-catalog-overlay'
import type { WorkspacePathCatalog } from '../../shared/workspace-path-catalog'
import { parseWslPath } from '../wsl'
import { resolveAuthorizedPath } from './filesystem-auth'
import { getLocalGitOptionsForRegisteredWorktree } from './local-worktree-runtime-options'
import { scanRipgrepPaths } from './quick-open-rg-path-scan'
import { RipgrepUnavailableError } from '../../shared/ripgrep-process-availability'
import { bundledRipgrepUnavailableError } from '../ripgrep/bundled-ripgrep-path'
import { buildWorkspacePathCatalogInWorker } from './workspace-path-catalog-worker-discovery'

export type WorkspacePathCatalogWorkerBuildScope = {
  generationId: string
  readyScope: WorkspacePathSearchPathSet
  retainedBytes: number
  complete: boolean
  storageMode?: 'packed-folded' | 'disk-spilled'
  spillFileBytes?: number
  degradationReason?: string
}

export type WorkspacePathCatalogWorkerBuildSink = {
  begin(): Promise<void>
  addBatch(pathSet: WorkspacePathSearchPathSet, paths: readonly string[]): Promise<boolean>
  finishScope(pathSet: WorkspacePathSearchPathSet): Promise<WorkspacePathCatalogWorkerBuildScope>
  abort(preservePublished: boolean): Promise<void>
}

export type WorkspacePathCatalogDiscoveryResult = {
  catalog: WorkspacePathCatalog | null
  overlay?: WorkspacePathCatalogOverlay
  workerGenerationId?: string
  workerRetainedBytes?: number
  workerStorageMode?: 'packed-folded' | 'disk-spilled'
  workerSpillFileBytes?: number
  degradationReason?: 'over-budget' | 'failed' | 'spill-unavailable'
}

export type WorkspacePathCatalogDiscoveryOptions = {
  firstScope: WorkspacePathSearchPathSet
  generationId: string
  overlayGenerationId: string
  maxBytes: number
  freshness?: string
  excludePaths?: string[]
  signal?: AbortSignal
  correlationId?: WorkspacePathSearchCorrelationId
  onInstrumentation?: (event: WorkspacePathSearchInstrumentationEvent) => void
  onScopePublished?: (catalog: WorkspacePathCatalog) => void
  workerBuild?: WorkspacePathCatalogWorkerBuildSink
  onWorkerScopePublished?: (scope: WorkspacePathCatalogWorkerBuildScope) => void
}

/** Runs the two existing rg scope policies directly into bounded catalog builders. */
export async function buildWorkspacePathCatalogFromDiscovery(
  rootPath: string,
  store: Store,
  options: WorkspacePathCatalogDiscoveryOptions
): Promise<WorkspacePathCatalogDiscoveryResult> {
  const authorizedRootPath = await resolveAuthorizedPath(rootPath, store)
  const localGitOptions = getLocalGitOptionsForRegisteredWorktree(
    store,
    rootPath,
    authorizedRootPath
  )
  const wslDistroForOutput = parseWslPath(authorizedRootPath)?.distro ?? localGitOptions.wslDistro
  const excludePathPrefixes = buildExcludePathPrefixes(authorizedRootPath, options.excludePaths)
  const rgArgs = buildRgArgsForQuickOpen({
    searchRoot: '.',
    excludePathPrefixes: options.workerBuild ? [] : excludePathPrefixes,
    forceSlashSeparator: sep === '\\'
  })
  if (options.workerBuild) {
    return buildWorkspacePathCatalogInWorker({
      authorizedRootPath,
      excludePathPrefixes: [],
      localGitOptions,
      options,
      rgArgs,
      workerBuild: options.workerBuild,
      wslDistroForOutput
    })
  }
  const builder = new WorkspacePathCatalogBuilder({
    generationId: options.generationId,
    maxBytes: options.maxBytes,
    storage: 'packed-folded',
    onInstrumentation: options.onInstrumentation,
    correlationId: options.correlationId,
    freshness: options.freshness,
    coverageExcludePathSegments: excludePathPrefixes.map((prefix) => prefix.split('/'))
  })

  const firstPassStartedAt = performance.now()
  await runDiscoveryPass(options.firstScope, (path) => builder.addPath(path, options.firstScope))
  emitStage(options, 'enumeration', performance.now() - firstPassStartedAt)
  if (builder.isOverBudget) {
    return { catalog: null, degradationReason: 'over-budget' }
  }
  builder.markScopeComplete(options.firstScope)
  const catalog = builder.finish({ retainPathLookup: true })
  if (!catalog) {
    return { catalog: null, degradationReason: builder.isOverBudget ? 'over-budget' : 'failed' }
  }
  options.onScopePublished?.(catalog)

  const secondScope: WorkspacePathSearchPathSet =
    options.firstScope === 'included' ? 'all' : 'included'
  const availableOverlayBytes =
    options.maxBytes - catalog.retainedBytes - builder.lookupRetainedBytes
  const overlayBuilder = new WorkspacePathCatalogOverlayBuilder(catalog, {
    generationId: options.overlayGenerationId,
    maxBytes: availableOverlayBytes,
    findBasePathId: (path) => builder.findPathId(path),
    onInstrumentation: options.onInstrumentation,
    correlationId: options.correlationId
  })
  if (overlayBuilder.isOverBudget) {
    builder.releasePathLookup()
    return { catalog, degradationReason: 'over-budget' }
  }

  const secondPassStartedAt = performance.now()
  try {
    await runDiscoveryPass(secondScope, (path) => overlayBuilder.addPath(path, secondScope))
  } catch {
    builder.releasePathLookup()
    if (options.signal?.aborted) {
      throw new Error('Workspace path catalog discovery was cancelled')
    }
    return { catalog, degradationReason: 'failed' }
  }
  emitStage(options, 'enumeration', performance.now() - secondPassStartedAt)
  if (overlayBuilder.isOverBudget) {
    builder.releasePathLookup()
    return { catalog, degradationReason: 'over-budget' }
  }
  overlayBuilder.markScopeComplete(secondScope)
  overlayBuilder.completeClassification()
  const overlay = overlayBuilder.finish()
  builder.releasePathLookup()
  return overlay ? { catalog, overlay } : { catalog, degradationReason: 'over-budget' }

  async function runDiscoveryPass(
    pathSet: WorkspacePathSearchPathSet,
    onPath: (path: string) => boolean
  ): Promise<void> {
    await scanRipgrepPaths({
      args: pathSet === 'included' ? rgArgs.primary : rgArgs.ignoredPass,
      authorizedRootPath,
      excludePathPrefixes,
      localGitOptions,
      onPath,
      signal: options.signal,
      wslDistroForOutput
    }).catch((error: unknown) => {
      // Why: a bundled rg that cannot start is a damaged install, not a remote tool to install.
      throw error instanceof RipgrepUnavailableError ? bundledRipgrepUnavailableError() : error
    })
  }
}

function emitStage(
  options: WorkspacePathCatalogDiscoveryOptions,
  stage: 'enumeration',
  milliseconds: number
): void {
  options.onInstrumentation?.({
    kind: 'stage-timing',
    record: {
      correlationId: options.correlationId ?? 'workspace-path-catalog-build',
      stage,
      duration: { milliseconds, clock: 'execution-host-monotonic' }
    }
  })
}
