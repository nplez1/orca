import type { WorkspacePathCatalogGeneration } from './workspace-path-catalog'
import type { WorkspacePathSearchCancellationToken } from './workspace-path-catalog-query-scheduling'
import {
  shouldYieldWorkspacePathQuery,
  WorkspacePathSearchCancelledError
} from './workspace-path-catalog-query-scheduling'

export async function walkWorkspacePathCatalog(
  generation: WorkspacePathCatalogGeneration,
  options: {
    cancellation?: WorkspacePathSearchCancellationToken
    yieldToWorker: () => Promise<void>
    candidateRanks?: Uint32Array | null
    visitBasePath: (rank: number, pathId: number) => void
    visitDeltaPath: (path: string, foldedPath: string, flags: number) => void
  }
): Promise<void> {
  const { catalog, overlay } = generation
  const delta = overlay?.delta ?? []
  let chunkStart = performance.now()
  let pathsSinceYield = 0

  if (options.candidateRanks == null) {
    let deltaIndex = 0
    for (let rank = 0; rank <= catalog.pathCount; rank += 1) {
      while (delta[deltaIndex]?.baseRank === rank) {
        const entry = delta[deltaIndex]
        if (entry) {
          options.visitDeltaPath(entry.relativePath, entry.foldedPath, entry.flags)
        }
        deltaIndex += 1
        pathsSinceYield += 1
        await yieldIfDue()
      }
      if (rank === catalog.pathCount) {
        break
      }
      const pathId = catalog.naturalOrder[rank]
      if (pathId !== undefined) {
        options.visitBasePath(rank, pathId)
      }
      pathsSinceYield += 1
      await yieldIfDue()
    }
    return
  }

  let deltaIndex = 0
  let candidateIndex = 0
  while (deltaIndex < delta.length || candidateIndex < options.candidateRanks.length) {
    const candidateRank = options.candidateRanks[candidateIndex]
    const deltaRank = delta[deltaIndex]?.baseRank
    const rank = Math.min(
      candidateRank ?? Number.POSITIVE_INFINITY,
      deltaRank ?? Number.POSITIVE_INFINITY
    )
    if (!Number.isFinite(rank)) {
      break
    }
    while (delta[deltaIndex]?.baseRank === rank) {
      const entry = delta[deltaIndex]
      if (entry) {
        options.visitDeltaPath(entry.relativePath, entry.foldedPath, entry.flags)
      }
      deltaIndex += 1
      pathsSinceYield += 1
      await yieldIfDue()
    }
    if (candidateRank === rank) {
      if (rank < catalog.pathCount) {
        const pathId = catalog.naturalOrder[rank]
        if (pathId !== undefined) {
          options.visitBasePath(rank, pathId)
        }
      }
      candidateIndex += 1
      pathsSinceYield += 1
      await yieldIfDue()
    }
  }

  async function yieldIfDue(): Promise<void> {
    if (pathsSinceYield % 32 === 0) {
      throwIfCancelled()
    }
    if (!shouldYieldWorkspacePathQuery(pathsSinceYield, chunkStart)) {
      return
    }
    throwIfCancelled()
    await options.yieldToWorker()
    throwIfCancelled()
    pathsSinceYield = 0
    chunkStart = performance.now()
  }

  function throwIfCancelled(): void {
    if (options.cancellation?.isCancelled()) {
      throw new WorkspacePathSearchCancelledError()
    }
  }
}
