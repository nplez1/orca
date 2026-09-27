import { dirname } from 'node:path'
import { WorkspacePathCatalogBuilder } from '../../shared/workspace-path-catalog-builder'
import type { WorkspacePathSearchPathSet } from '../../shared/workspace-path-search-contract'
import type { WorkspacePathSearchInstrumentationEvent } from '../../shared/workspace-path-search-instrumentation'
import {
  cleanStaleWorkspacePathCatalogSpillDirectories,
  prepareWorkspacePathCatalogSpillDirectory
} from './workspace-path-catalog-spill'
import { WorkspacePathCatalogSpillRuns } from './workspace-path-catalog-spill-runs'
import {
  addWorkspacePathIndexOverlayBatch,
  decodeWorkspacePathIndexBatch
} from './workspace-path-index-worker-batch'
import { WorkspacePathIndexWorkerBuildLaneSpill } from './workspace-path-index-worker-build-lane-spill'
import type { WorkspacePathIndexWorkerRequest } from './workspace-path-index-worker-protocol'

/** Build/scope admission for the path-index worker: begin a build and admit path batches. */
export abstract class WorkspacePathIndexWorkerBuildLaneBuild extends WorkspacePathIndexWorkerBuildLaneSpill {
  async begin(
    request: Extract<WorkspacePathIndexWorkerRequest, { type: 'begin-build' }>
  ): Promise<void> {
    if (this.builds.has(request.buildId)) {
      throw new Error('Workspace path index build ID is already active')
    }
    if (request.spillDirectory && !this.preparedSpillDirectories.has(request.spillDirectory)) {
      const directoryHasLiveSpill = [...this.generations.values()].some(
        (generation) =>
          generation.catalog.storageKind === 'disk-spilled' &&
          dirname(generation.catalog.spillFilePath) === request.spillDirectory
      )
      await cleanStaleWorkspacePathCatalogSpillDirectories(request.spillDirectory)
      if (!directoryHasLiveSpill) {
        await prepareWorkspacePathCatalogSpillDirectory(request.spillDirectory)
      }
      this.preparedSpillDirectories.add(request.spillDirectory)
      this.spillDirectoryByRoot.set(request.key, request.spillDirectory)
    }
    const events: WorkspacePathSearchInstrumentationEvent[] = []
    const builder = new WorkspacePathCatalogBuilder({
      generationId: request.generationId,
      maxBytes: request.maxBytes,
      storage: 'packed-folded',
      freshness: 'no-known-gap',
      onInstrumentation: (event) => events.push(event),
      correlationId: request.correlationId
    })
    this.builds.set(request.buildId, {
      buildId: request.buildId,
      key: request.key,
      generationId: request.generationId,
      firstScope: request.firstScope,
      secondScope: request.firstScope === 'included' ? 'all' : 'included',
      builder,
      catalog: null,
      overlayBuilder: null,
      events,
      maxBytes: request.maxBytes,
      overBudget: false,
      correlationId: request.correlationId,
      cancelled: false,
      spillRuns: request.spillDirectory
        ? new WorkspacePathCatalogSpillRuns(
            request.spillDirectory,
            request.key,
            request.generationId,
            { isCancelled: () => this.builds.get(request.buildId)?.cancelled ?? false },
            dirname(request.spillDirectory)
          )
        : null,
      spillAvailable: request.spillDirectory !== undefined,
      spillMode: false
    })
  }

  async addBatch(
    buildId: string,
    pathSet: WorkspacePathSearchPathSet,
    bytes: ArrayBuffer,
    offsets: Uint32Array,
    pathCount: number
  ): Promise<{
    accepted: boolean
    readyScope: WorkspacePathSearchPathSet
    generationId: string
    retainedBytes: number
  }> {
    const build = this.requireBuild(buildId)
    if (build.cancelled) {
      return {
        accepted: false,
        readyScope: build.firstScope,
        generationId: build.generationId,
        retainedBytes: 0
      }
    }
    if (!build.overBudget) {
      if (build.catalog && pathSet !== build.secondScope) {
        throw new Error('Path batch does not match the active workspace scope')
      }
      if (!build.catalog && pathSet !== build.firstScope) {
        throw new Error('Requested path scope must be discovered first')
      }
      const paths = decodeWorkspacePathIndexBatch(bytes, offsets, pathCount)
      if (build.spillAvailable && build.spillRuns) {
        try {
          build.spillAvailable = await build.spillRuns.addBatch(pathSet, paths)
          if (!build.spillAvailable) {
            await build.spillRuns.cleanupAll()
          }
        } catch {
          build.spillAvailable = false
          await build.spillRuns.cleanupAll()
        }
      }
      if (build.spillMode) {
        if (!build.spillAvailable) {
          build.overBudget = true
          build.degradationReason = 'spill-unavailable'
        }
      } else {
        const accepted = build.catalog
          ? addWorkspacePathIndexOverlayBatch(build.overlayBuilder, paths, pathSet)
          : build.builder.addBatch(paths, pathSet)
        if (!accepted && build.spillAvailable && build.spillRuns) {
          build.spillMode = true
          build.builder.takeBuildRecordsForSpill()
          build.builder.releasePathLookup()
          build.overlayBuilder = null
        } else {
          build.overBudget = !accepted
          if (!accepted) {
            build.degradationReason = 'over-budget'
          }
        }
      }
    }
    return {
      accepted: !build.overBudget,
      readyScope: build.catalog ? build.firstScope : pathSet,
      generationId: build.catalog?.generationId ?? build.generationId,
      retainedBytes: build.catalog?.retainedBytes ?? 0
    }
  }
}
