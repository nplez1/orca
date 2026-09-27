import type { WorkspacePathCatalogGeneration } from '../../shared/workspace-path-catalog'
import { WorkspacePathCatalogOverlayBuilder } from '../../shared/workspace-path-catalog-overlay'
import { finishWorkspacePathCatalogBuilderInWorker } from '../../shared/workspace-path-catalog-builder-worker'
import { isWorkspacePathCatalogCompactionDue } from '../../shared/workspace-path-catalog-compaction'
import type { WorkspacePathSearchPathSet } from '../../shared/workspace-path-search-contract'
import { compactCatalogGenerationInWorker } from './workspace-path-index-worker-compaction'
import {
  createWorkspacePathIndexPartialBuildResult,
  type WorkspacePathIndexWorkerBuildResultBundle
} from './workspace-path-index-worker-build-result'
import { WorkspacePathIndexWorkerBuildLaneBuild } from './workspace-path-index-worker-build-lane-build'
import { publishWorkspacePathIndexWorkerGeneration } from './workspace-path-index-worker-generation'

/** Scope publication for the path-index worker: finish and publish each discovered scope. */
export abstract class WorkspacePathIndexWorkerBuildLaneScope extends WorkspacePathIndexWorkerBuildLaneBuild {
  async finishScope(
    buildId: string,
    pathSet: WorkspacePathSearchPathSet
  ): Promise<WorkspacePathIndexWorkerBuildResultBundle> {
    const build = this.requireBuild(buildId)
    if (build.cancelled) {
      throw new Error('Workspace path catalog build was cancelled')
    }
    if (build.spillMode) {
      return this.finishSpilledScope(build, pathSet)
    }
    if (!build.catalog) {
      if (build.overBudget) {
        this.builds.delete(buildId)
        return {
          build: {
            buildId,
            readyScope: build.firstScope,
            generationId: build.generationId,
            retainedBytes: 0,
            complete: false,
            degradationReason: build.degradationReason ?? 'over-budget'
          },
          events: build.events.splice(0)
        }
      }
      if (pathSet !== build.firstScope) {
        throw new Error('Requested path scope must be published first')
      }
      build.builder.markScopeComplete(pathSet)
      const catalog = await finishWorkspacePathCatalogBuilderInWorker(build.builder, {
        retainPathLookup: true,
        cancellation: { isCancelled: () => build.cancelled }
      })
      if (build.cancelled || this.builds.get(buildId) !== build) {
        throw new Error('Workspace path catalog build was cancelled')
      }
      if (!catalog && build.spillAvailable && build.spillRuns) {
        build.spillMode = true
        build.builder.takeBuildRecordsForSpill()
        return this.finishSpilledScope(build, pathSet)
      }
      if (!catalog) {
        await build.spillRuns?.cleanupScratch()
        this.builds.delete(buildId)
        return {
          build: {
            buildId,
            readyScope: pathSet,
            generationId: build.generationId,
            retainedBytes: 0,
            complete: false,
            degradationReason: 'over-budget'
          },
          events: build.events.splice(0)
        }
      }
      let publishedCatalog = catalog
      const createOverlayBuilder = (base: typeof publishedCatalog) =>
        new WorkspacePathCatalogOverlayBuilder(base, {
          generationId: `${build.generationId}:overlay`,
          maxBytes: Math.max(
            0,
            build.maxBytes - base.retainedBytes - build.builder.lookupRetainedBytes
          ),
          findBasePathId: (path) => build.builder.findPathId(path),
          onInstrumentation: (event) => build.events.push(event),
          correlationId: build.correlationId
        })
      let overlayBuilder = createOverlayBuilder(publishedCatalog)
      if (overlayBuilder.isOverBudget && publishedCatalog.trigramPostings) {
        const { trigramPostings, ...catalogWithoutPostings } = publishedCatalog
        catalogWithoutPostings.retainedBytes -= trigramPostings.retainedBytes
        publishedCatalog = catalogWithoutPostings
        overlayBuilder = createOverlayBuilder(publishedCatalog)
        build.events.push({
          kind: 'degradation',
          correlationId: build.correlationId,
          reason: 'trigram-postings-discarded-before-catalog'
        })
      }
      build.catalog = publishedCatalog
      build.overlayBuilder = overlayBuilder
      publishWorkspacePathIndexWorkerGeneration({
        generations: this.generations,
        latestGenerationIds: this.latestGenerationIds,
        rootKey: build.key,
        generationId: publishedCatalog.generationId,
        generation: { catalog: publishedCatalog }
      })
      const overlayOverBudget = build.overlayBuilder.isOverBudget
      if (overlayOverBudget && build.spillAvailable && build.spillRuns) {
        build.spillMode = true
        this.releaseLookup(build)
        build.overlayBuilder = null
      } else if (overlayOverBudget) {
        this.releaseLookup(build)
        await build.spillRuns?.cleanupScratch()
        this.builds.delete(buildId)
      }
      return {
        build: {
          buildId,
          readyScope: pathSet,
          generationId: publishedCatalog.generationId,
          retainedBytes: publishedCatalog.retainedBytes,
          trigramPostingsBytes: publishedCatalog.trigramPostings?.retainedBytes ?? 0,
          complete: false,
          storageMode: 'packed-folded',
          ...(overlayOverBudget && !build.spillMode
            ? { degradationReason: build.degradationReason ?? 'over-budget' }
            : {})
        },
        events: build.events.splice(0)
      }
    }
    if (pathSet !== build.secondScope) {
      throw new Error('The other path scope must follow the requested scope')
    }
    const overlayBuilder = build.overlayBuilder
    if (build.overBudget || !overlayBuilder || overlayBuilder.isOverBudget) {
      if (build.spillAvailable && build.spillRuns) {
        build.spillMode = true
        this.releaseLookup(build)
        return this.finishSpilledScope(build, pathSet)
      }
      this.releaseLookup(build)
      await build.spillRuns?.cleanupScratch()
      this.builds.delete(buildId)
      return createWorkspacePathIndexPartialBuildResult({
        buildId,
        readyScope: build.firstScope,
        generationId: build.catalog.generationId,
        retainedBytes: build.catalog.retainedBytes,
        events: build.events,
        degradationReason: 'over-budget'
      })
    }
    overlayBuilder.markScopeComplete(pathSet)
    await overlayBuilder.completeClassificationInWorker({
      isCancelled: () => build.cancelled
    })
    const overlay = await overlayBuilder.finishInWorker({
      isCancelled: () => build.cancelled
    })
    if (build.cancelled || this.builds.get(buildId) !== build) {
      throw new Error('Workspace path catalog build was cancelled')
    }
    this.releaseLookup(build)
    await build.spillRuns?.cleanupScratch()
    this.builds.delete(buildId)
    if (!overlay && build.spillAvailable && build.spillRuns) {
      build.spillMode = true
      return this.finishSpilledScope(build, pathSet)
    }
    if (!overlay) {
      return createWorkspacePathIndexPartialBuildResult({
        buildId,
        readyScope: build.firstScope,
        generationId: build.catalog.generationId,
        retainedBytes: build.catalog.retainedBytes,
        events: build.events,
        degradationReason: 'over-budget'
      })
    }
    let generation: WorkspacePathCatalogGeneration = { catalog: build.catalog, overlay }
    if (isWorkspacePathCatalogCompactionDue(generation)) {
      const compacted = await compactCatalogGenerationInWorker({
        generation,
        generationId: `${overlay.generationId}:compacted`,
        maxBytes: build.maxBytes,
        cancellation: { isCancelled: () => build.cancelled }
      })
      if (build.cancelled || this.builds.get(buildId) !== build) {
        throw new Error('Workspace path catalog build was cancelled')
      }
      if (compacted) {
        generation = compacted
      }
    }
    const generationId = generation.overlay?.generationId ?? generation.catalog.generationId
    publishWorkspacePathIndexWorkerGeneration({
      generations: this.generations,
      latestGenerationIds: this.latestGenerationIds,
      rootKey: build.key,
      generationId,
      generation
    })
    return {
      build: {
        buildId,
        readyScope: pathSet,
        generationId,
        retainedBytes: generation.catalog.retainedBytes + (generation.overlay?.retainedBytes ?? 0),
        trigramPostingsBytes: generation.catalog.trigramPostings?.retainedBytes ?? 0,
        storageMode: 'packed-folded',
        complete: true
      },
      events: build.events.splice(0)
    }
  }
}
