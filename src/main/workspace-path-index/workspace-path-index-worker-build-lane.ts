import { removeWorkspacePathCatalogSpill } from './workspace-path-catalog-spill'
import { WorkspacePathIndexWorkerBuildLaneScope } from './workspace-path-index-worker-build-lane-scope'
import { compactCatalogGenerationInWorker } from './workspace-path-index-worker-compaction'
import {
  publishWorkspacePathIndexWorkerGeneration,
  workspacePathIndexWorkerGenerationKey
} from './workspace-path-index-worker-generation'

/** Owner of in-flight path-index builds; compacts, discards, cancels, and aborts them. */
export class WorkspacePathIndexWorkerBuildLane extends WorkspacePathIndexWorkerBuildLaneScope {
  compact(
    key: string,
    generationId: string,
    maxBytes: number
  ): Promise<{ generationId: string; retainedBytes: number } | null> {
    const storeKey = workspacePathIndexWorkerGenerationKey(key, generationId)
    const current = this.generations.get(storeKey)
    if (!current) {
      return Promise.resolve(null)
    }
    return compactCatalogGenerationInWorker({
      generation: current,
      generationId: `${generationId}:compacted`,
      maxBytes
    }).then((compacted) => {
      if (!compacted) {
        return null
      }
      const compactedGenerationId =
        compacted.overlay?.generationId ?? compacted.catalog.generationId
      publishWorkspacePathIndexWorkerGeneration({
        generations: this.generations,
        latestGenerationIds: this.latestGenerationIds,
        rootKey: key,
        generationId: compactedGenerationId,
        generation: compacted
      })
      return {
        generationId: compactedGenerationId,
        retainedBytes: compacted.catalog.retainedBytes + (compacted.overlay?.retainedBytes ?? 0)
      }
    })
  }

  discardOptionalStructures(key: string, generationId: string): number {
    const storeKey = workspacePathIndexWorkerGenerationKey(key, generationId)
    const generation = this.generations.get(storeKey)
    if (!generation) {
      return 0
    }
    const { trigramPostings, ...catalogWithoutPostings } = generation.catalog
    if (!trigramPostings) {
      return 0
    }
    catalogWithoutPostings.retainedBytes -= trigramPostings.retainedBytes
    this.generations.set(storeKey, { ...generation, catalog: catalogWithoutPostings })
    return trigramPostings.retainedBytes
  }

  cancel(buildId: string): void {
    const build = this.builds.get(buildId)
    if (build) {
      build.cancelled = true
    }
  }

  abort(buildId: string, preservePublished: boolean): void {
    const build = this.builds.get(buildId)
    if (!build) {
      return
    }
    build.cancelled = true
    if (!preservePublished && this.latestGenerationIds.get(build.key) === build.generationId) {
      const storeKey = workspacePathIndexWorkerGenerationKey(build.key, build.generationId)
      const generation = this.generations.get(storeKey)
      this.generations.delete(storeKey)
      this.latestGenerationIds.delete(build.key)
      if (generation) {
        void removeWorkspacePathCatalogSpill(generation.catalog).catch(() => undefined)
      }
    }
    this.releaseLookup(build)
    void build.spillRuns?.cleanupScratch()
    this.builds.delete(buildId)
  }
}
