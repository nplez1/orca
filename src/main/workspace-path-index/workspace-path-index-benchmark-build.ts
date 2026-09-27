import { performance } from 'node:perf_hooks'
import {
  generateWorkspacePathCatalog,
  type WorkspacePathCatalogProfile
} from '../../shared/__fixtures__/workspace-path-catalog'
import { isEligibleWorkspaceCatalogPath } from '../../shared/workspace-path-catalog'
import { sampleProcessMemoryUsage } from '../../shared/__fixtures__/workspace-path-memory-measurement'
import type {
  WorkspacePathIndexBuildRequest,
  WorkspacePathIndexBuildResult
} from './workspace-path-index-build'
import { WORKSPACE_PATH_INDEX_BUILD_BOUND_BYTES } from './workspace-path-index-build-budget'
import type { WorkspacePathIndexWorkerClient } from './workspace-path-index-worker-client'
import type {
  BenchmarkBuildOutcome,
  WorkerMemoryUsageSample
} from './workspace-path-index-benchmark-fixture'

export type BenchmarkBuildObservations = {
  startedAt: number
  finishedAt: number
  firstScopeReadyAt: number | null
  allScopesReadyAt: number | null
  cpuUserMicroseconds: number
  cpuSystemMicroseconds: number
  outcome: BenchmarkBuildOutcome | null
  degradationReason: string | null
  error: string | null
  memorySamples: ReturnType<typeof sampleProcessMemoryUsage>[]
  workerMemorySamples: WorkerMemoryUsageSample[]
  startWorkerMemorySampling: () => void
  stopWorkerMemorySampling: () => void
  resolveComplete: (() => void) | null
}

export function createBenchmarkBuildCallback(args: {
  worker: WorkspacePathIndexWorkerClient
  size: number
  profile: WorkspacePathCatalogProfile
  memoryBudgetBytes: number
  observations: BenchmarkBuildObservations
}): (request: WorkspacePathIndexBuildRequest) => Promise<WorkspacePathIndexBuildResult> {
  return async (request) => {
    const cpuBefore = process.cpuUsage()
    args.observations.startedAt = performance.now()
    args.observations.startWorkerMemorySampling()
    const sample = (): void => {
      args.observations.memorySamples.push(sampleProcessMemoryUsage())
    }
    sample()
    const sampler = setInterval(sample, 10)
    const buildId = `${request.generationId}:${request.buildGeneration}`
    try {
      await args.worker.beginCatalogBuild({
        key: request.key,
        buildId,
        generationId: request.generationId,
        firstScope: 'included',
        // Why: production bounds the catalog builder by the host build-peak allowance, not the root cap.
        maxBytes: Math.max(args.memoryBudgetBytes, WORKSPACE_PATH_INDEX_BUILD_BOUND_BYTES),
        correlationId: request.correlationId
      })
      for (const pathSet of ['included', 'all'] as const) {
        let batch: string[] = []
        let forwardedPathCount = 0
        for (const path of generateWorkspacePathCatalog({
          size: Math.ceil(args.size * 1.3),
          profile: args.profile,
          seed: 0x50455246
        })) {
          if (request.signal.aborted) {
            throw new Error('Benchmark build was cancelled')
          }
          if (!isEligibleWorkspaceCatalogPath(path)) {
            continue
          }
          batch.push(path)
          forwardedPathCount += 1
          if (batch.length >= 256) {
            if (!(await args.worker.appendCatalogPathBatch(buildId, pathSet, batch))) {
              args.observations.degradationReason = 'over-budget'
              return {
                generationId: request.generationId,
                retainedBytes: 0,
                degradationReason: 'over-budget'
              }
            }
            batch = []
          }
          if (forwardedPathCount === args.size) {
            break
          }
        }
        if (forwardedPathCount !== args.size) {
          throw new Error('Benchmark fixture did not produce the requested eligible catalog size')
        }
        if (
          batch.length > 0 &&
          !(await args.worker.appendCatalogPathBatch(buildId, pathSet, batch))
        ) {
          args.observations.degradationReason = 'over-budget'
          return {
            generationId: request.generationId,
            retainedBytes: 0,
            degradationReason: 'over-budget'
          }
        }
        const scope = await args.worker.finishCatalogScope(buildId, pathSet)
        request.onScopePublished(scope.generationId, scope.retainedBytes, scope.complete)
        if (pathSet === 'included') {
          args.observations.firstScopeReadyAt = performance.now()
        } else {
          args.observations.allScopesReadyAt = performance.now()
          if (!scope.degradationReason) {
            args.observations.outcome = {
              generationId: scope.generationId,
              retainedBytes: scope.retainedBytes,
              trigramPostingsBytes: scope.trigramPostingsBytes ?? 0,
              ...(scope.storageMode ? { storageMode: scope.storageMode } : {}),
              ...(scope.spillFileBytes === undefined
                ? {}
                : { spillFileBytes: scope.spillFileBytes })
            }
          }
        }
        if (scope.degradationReason) {
          args.observations.degradationReason = scope.degradationReason
          return {
            generationId: scope.generationId,
            retainedBytes: scope.retainedBytes,
            ...(scope.storageMode ? { storageMode: scope.storageMode } : {}),
            ...(scope.spillFileBytes === undefined ? {} : { spillFileBytes: scope.spillFileBytes }),
            degradationReason: scope.degradationReason
          }
        }
      }
      return (
        args.observations.outcome ?? {
          generationId: request.generationId,
          retainedBytes: 0,
          degradationReason: 'failed'
        }
      )
    } catch (error) {
      args.observations.error = error instanceof Error ? error.message : String(error)
      args.observations.degradationReason = 'failed'
      await args.worker.abortCatalogBuild(buildId, true).catch(() => undefined)
      return {
        generationId: request.generationId,
        retainedBytes: 0,
        degradationReason: 'failed'
      }
    } finally {
      clearInterval(sampler)
      args.observations.stopWorkerMemorySampling()
      sample()
      args.observations.finishedAt = performance.now()
      const cpu = process.cpuUsage(cpuBefore)
      args.observations.cpuUserMicroseconds = cpu.user
      args.observations.cpuSystemMicroseconds = cpu.system
      args.observations.resolveComplete?.()
      args.observations.resolveComplete = null
    }
  }
}
