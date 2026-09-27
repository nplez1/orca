import {
  validateWorkspacePathSearchQuery,
  type WorkspacePathSearchResponse,
  type WorkspacePathSearchRowClassificationFlags
} from './workspace-path-search-contract'
import {
  getWorkspacePathCatalogFoldedPath,
  getWorkspacePathCatalogOriginalPath,
  resolveWorkspacePathFoldLocale,
  WORKSPACE_PATH_CATALOG_FOLD_VERSION,
  type WorkspacePathCatalogGeneration
} from './workspace-path-catalog'
import {
  boundedWorkspacePathPageCount,
  workspaceCatalogPackedPathMatchesTokens,
  emptyWorkspacePathsPayloadBytes,
  pathIsInWorkspaceCatalogScope,
  workspaceCatalogRowClassificationFlags,
  workspacePathCatalogJsonStringByteLength
} from './workspace-path-catalog-query-policy'
import {
  emitWorkspacePathQueryInstrumentation,
  shouldYieldWorkspacePathQuery,
  throwIfWorkspacePathQueryCancelled,
  yieldWorkspacePathQuery,
  WorkspacePathCatalogFoldVersionError,
  WorkspacePathCatalogGenerationUnavailableError,
  type WorkspacePathCatalogQueryOptions
} from './workspace-path-catalog-query-scheduling'
import { walkWorkspacePathCatalog } from './workspace-path-catalog-query-walk'
import { selectWorkspacePathCatalogTrigramCandidates } from './workspace-path-catalog-trigram'
import { workspacePathCatalogPrefixCacheCounters } from './workspace-path-catalog-blocks'
import { createWorkspacePathCatalogDecodedBlockReader } from './workspace-path-catalog-query-decoded-block'
import { workspacePathProvisionalPageBudgetExhausted } from './workspace-path-provisional-page-budget'
import { buildWorkspacePathSearchResponse } from './workspace-path-catalog-query-response'

export {
  workspacePathCatalogJsonStringByteLength,
  workspacePathSearchScopeFingerprint
} from './workspace-path-catalog-query-policy'
export {
  WORKSPACE_PATH_CATALOG_QUERY_CHUNK_MILLISECONDS,
  WORKSPACE_PATH_CATALOG_QUERY_CHUNK_PATHS,
  WorkspacePathCatalogFoldVersionError,
  WorkspacePathCatalogGenerationUnavailableError,
  WorkspacePathSearchCancelledError,
  type WorkspacePathCatalogQueryOptions,
  type WorkspacePathSearchCancellationToken
} from './workspace-path-catalog-query-scheduling'

type RetainedPath = {
  path: string
  classificationFlags: WorkspacePathSearchRowClassificationFlags
}

/** Pure worker-ready ordered scan; the pinned generation is never mutated or substituted. */
export async function queryWorkspacePathCatalog(
  generation: WorkspacePathCatalogGeneration | WorkspacePathCatalogGeneration['catalog'],
  options: WorkspacePathCatalogQueryOptions
): Promise<WorkspacePathSearchResponse> {
  const pinnedGeneration = 'catalog' in generation ? generation : { catalog: generation }
  const startedAt = performance.now()
  const { catalog, overlay } = pinnedGeneration
  const prefixCacheHitsBefore =
    catalog.storageKind === 'prefix-compressed'
      ? workspacePathCatalogPrefixCacheCounters(catalog).hits
      : 0
  const identity = options.identity
  if (identity.mode !== 'name-filter') {
    throw new TypeError('Workspace path catalogs only implement name-filter mode')
  }
  if (
    catalog.metadata.foldVersion !== WORKSPACE_PATH_CATALOG_FOLD_VERSION ||
    catalog.metadata.foldLocale !== resolveWorkspacePathFoldLocale()
  ) {
    throw new WorkspacePathCatalogFoldVersionError()
  }
  const generationId = overlay?.generationId ?? catalog.generationId
  if (identity.generationId !== null && identity.generationId !== generationId) {
    throw new WorkspacePathCatalogGenerationUnavailableError()
  }
  const metadata = overlay?.metadata ?? catalog.metadata
  const validation = validateWorkspacePathSearchQuery(identity.query)
  if (!validation.ok) {
    throw new TypeError(`Workspace path search query is invalid: ${validation.reason}`)
  }
  const tokens = validation.tokens
  const prefixes = identity.scope.excludePathSegments
    .map((segments) => segments.join('/'))
    .filter((prefix) => prefix.length > 0)
  const maxPaths = boundedWorkspacePathPageCount(identity.pageBudget.maxPaths)
  const maxSerializedBytes = Number.isFinite(identity.pageBudget.maxSerializedBytes)
    ? Math.max(0, identity.pageBudget.maxSerializedBytes)
    : Number.POSITIVE_INFINITY
  const retained: RetainedPath[] = []
  let matches = 0
  let pathsConsidered = 0
  let candidates = 0
  let spillBlocksRead = 0
  let spillBytesRead = 0
  let retentionStopped = maxPaths === 0 || tokens.length === 0
  let scanComplete = true
  let retainedPathBytes = 0
  const retainedPathByteLengths: number[] = []
  const yieldToWorker = options.yieldToWorker ?? yieldWorkspacePathQuery
  const decodedBlockReader = createWorkspacePathCatalogDecodedBlockReader({ catalog, prefixes })

  const visitPath = (path: string, foldedPath: string, flags: number, baseId?: number): void => {
    pathsConsidered += 1
    if (!pathIsInWorkspaceCatalogScope(path, flags, identity.scope, prefixes)) {
      return
    }
    candidates += 1
    const pathMatches =
      baseId !== undefined &&
      (catalog.storageKind === 'packed-folded' || catalog.storageKind === 'prefix-compressed')
        ? workspaceCatalogPackedPathMatchesTokens(catalog, baseId, tokens)
        : tokens.every((token) => foldedPath.includes(token))
    if (tokens.length === 0 || !pathMatches) {
      return
    }
    matches += 1
    const emptyPageBytes = emptyWorkspacePathsPayloadBytes(matches)
    while (
      retained.length > 0 &&
      emptyPageBytes + retainedPathBytes + Math.max(0, retained.length - 1) > maxSerializedBytes
    ) {
      retained.pop()
      retainedPathBytes -= retainedPathByteLengths.pop() ?? 0
      retentionStopped = true
    }
    if (retentionStopped || retained.length >= maxPaths) {
      retentionStopped = true
      return
    }
    const retainedPath =
      baseId === undefined || path.length > 0
        ? path
        : getWorkspacePathCatalogOriginalPath(catalog, baseId)
    const encodedPathBytes = workspacePathCatalogJsonStringByteLength(retainedPath)
    const nextCount = retained.length + 1
    const nextSerializedBytes =
      emptyPageBytes + retainedPathBytes + encodedPathBytes + Math.max(0, nextCount - 1)
    if (nextSerializedBytes > maxSerializedBytes) {
      retentionStopped = true
      return
    }
    retained.push({
      path: retainedPath,
      classificationFlags: workspaceCatalogRowClassificationFlags(flags)
    })
    retainedPathByteLengths.push(encodedPathBytes)
    retainedPathBytes += encodedPathBytes
  }

  const processBasePath = (rank: number, pathId: number): void => {
    const flags = overlay?.baseFlagReplacementKnown[pathId]
      ? (overlay.baseFlagReplacements[pathId] ?? 0)
      : (catalog.flags[pathId] ?? 0) | (overlay?.baseFlagAdditions[pathId] ?? 0)
    if ((overlay?.baseTombstones[pathId] ?? 0) !== 0) {
      return
    }
    const path = prefixes.length > 0 ? decodedBlockReader.getOriginalAtRank(rank, pathId) : ''
    const foldedPath =
      catalog.storageKind === 'folded-strings'
        ? (catalog.foldedPaths[pathId] ?? '')
        : catalog.storageKind === 'prefix-compressed'
          ? getWorkspacePathCatalogFoldedPath(catalog, pathId)
          : ''
    visitPath(path, foldedPath, flags, pathId)
  }

  const candidateSelection =
    tokens.length > 0
      ? selectWorkspacePathCatalogTrigramCandidates(catalog, tokens)
      : { strategy: 'ordered-scan' as const, candidateRanks: null }
  if (tokens.length > 0 && catalog.storageKind === 'disk-spilled') {
    if (!options.readSpilledBlock) {
      throw new Error('Disk-spilled catalog has no block reader')
    }
    let rank = 0
    let pathsSinceYield = 0
    let chunkStartedAt = performance.now()
    // A restored provisional generation answers from a bounded prefix instead of a multi-second
    // full scan; the count arm downstream refuses any total computed over a partial prefix.
    const provisionalPageBudget = options.provisionalPageBudget
    const boundedScanStartedAt = performance.now()
    for (let blockIndex = 0; blockIndex < catalog.spillBlockCount; blockIndex += 1) {
      throwIfWorkspacePathQueryCancelled(options.cancellation)
      const block = await options.readSpilledBlock(blockIndex)
      spillBlocksRead += 1
      spillBytesRead += block.encodedByteLength
      for (let blockPathIndex = 0; blockPathIndex < block.originals.length; blockPathIndex += 1) {
        const path = block.originals[blockPathIndex]
        const foldedPath = block.folded[blockPathIndex]
        const flags = block.flags[blockPathIndex]
        if (path === undefined || foldedPath === undefined || flags === undefined) {
          throw new Error('Disk-spilled catalog block columns are inconsistent')
        }
        visitPath(path, foldedPath, flags)
        rank += 1
        pathsSinceYield += 1
        if (pathsSinceYield % 32 === 0) {
          throwIfWorkspacePathQueryCancelled(options.cancellation)
        }
        if (shouldYieldWorkspacePathQuery(pathsSinceYield, chunkStartedAt)) {
          await yieldToWorker()
          throwIfWorkspacePathQueryCancelled(options.cancellation)
          pathsSinceYield = 0
          chunkStartedAt = performance.now()
        }
      }
      if (
        provisionalPageBudget &&
        (retentionStopped ||
          workspacePathProvisionalPageBudgetExhausted({
            blocksRead: spillBlocksRead,
            encodedBytesRead: spillBytesRead,
            startedAt: boundedScanStartedAt,
            budget: provisionalPageBudget
          }))
      ) {
        scanComplete = false
        break
      }
    }
    if (scanComplete && rank !== catalog.pathCount) {
      throw new Error('Disk-spilled catalog scan did not cover every path')
    }
  } else if (tokens.length > 0) {
    await walkWorkspacePathCatalog(pinnedGeneration, {
      cancellation: options.cancellation,
      yieldToWorker,
      candidateRanks: candidateSelection.candidateRanks,
      visitBasePath: processBasePath,
      visitDeltaPath: (path, foldedPath, flags) => visitPath(path, foldedPath, flags)
    })
  }
  throwIfWorkspacePathQueryCancelled(options.cancellation)

  const response = buildWorkspacePathSearchResponse({
    identity,
    generationId,
    metadata,
    prefixes,
    rows: retained.map((entry) => ({ relativePath: entry.path })),
    rowClassificationFlags: retained.map((entry) => entry.classificationFlags),
    matches,
    scanComplete
  })
  const prefixCacheHitsAfter =
    catalog.storageKind === 'prefix-compressed'
      ? workspacePathCatalogPrefixCacheCounters(catalog).hits
      : prefixCacheHitsBefore
  emitWorkspacePathQueryInstrumentation(
    options,
    generationId,
    pathsConsidered,
    candidates,
    matches,
    retained.length,
    emptyWorkspacePathsPayloadBytes(matches) + retainedPathBytes + Math.max(0, retained.length - 1),
    performance.now() - startedAt,
    catalog.storageKind === 'disk-spilled' ? 'disk-block-scan' : candidateSelection.strategy,
    {
      storageMode:
        catalog.storageKind === 'disk-spilled'
          ? 'disk-spilled'
          : catalog.storageKind === 'prefix-compressed'
            ? 'resident-prefix-compressed'
            : catalog.storageKind === 'folded-strings'
              ? 'resident-strings'
              : 'resident-packed',
      ...(catalog.storageKind === 'disk-spilled'
        ? { spillBlocksRead, spillBytesRead, decodedBlockCacheHits: 0, scanComplete }
        : catalog.storageKind === 'prefix-compressed'
          ? { decodedBlockCacheHits: prefixCacheHitsAfter - prefixCacheHitsBefore }
          : {})
    }
  )
  return response
}
