import { dirname } from 'node:path'
import type { WorkspacePathCatalogGeneration } from '../../shared/workspace-path-catalog'
import type { WorkspacePathCatalogBuilder } from '../../shared/workspace-path-catalog-builder'
import type { WorkspacePathCatalogOverlayBuilder } from '../../shared/workspace-path-catalog-overlay'
import type { WorkspacePathSearchPathSet } from '../../shared/workspace-path-search-contract'
import type { WorkspacePathSearchInstrumentationEvent } from '../../shared/workspace-path-search-instrumentation'
import {
  cleanStaleWorkspacePathCatalogSpillDirectories,
  prepareWorkspacePathCatalogSpillDirectory,
  removeWorkspacePathCatalogSpill
} from './workspace-path-catalog-spill'
import { WorkspacePathCatalogSpillRuns } from './workspace-path-catalog-spill-runs'
import {
  createWorkspacePathIndexPartialBuildResult,
  type WorkspacePathIndexWorkerBuildResultBundle
} from './workspace-path-index-worker-build-result'
import {
  publishWorkspacePathIndexWorkerGeneration,
  workspacePathIndexWorkerGenerationKey
} from './workspace-path-index-worker-generation'

export type ActiveBuild = {
  buildId: string
  key: string
  generationId: string
  firstScope: WorkspacePathSearchPathSet
  secondScope: WorkspacePathSearchPathSet
  builder: WorkspacePathCatalogBuilder
  catalog: WorkspacePathCatalogGeneration['catalog'] | null
  overlayBuilder: WorkspacePathCatalogOverlayBuilder | null
  events: WorkspacePathSearchInstrumentationEvent[]
  maxBytes: number
  overBudget: boolean
  correlationId: string
  cancelled: boolean
  spillRuns: WorkspacePathCatalogSpillRuns | null
  spillAvailable: boolean
  spillMode: boolean
  degradationReason?: string
}

/** Spill-directory lifecycle and disk-spilled scope publication for the build lane. */
export abstract class WorkspacePathIndexWorkerBuildLaneSpill {
  protected readonly builds = new Map<string, ActiveBuild>()
  protected readonly preparedSpillDirectories = new Set<string>()
  protected readonly spillDirectoryByRoot = new Map<string, string>()

  constructor(
    protected readonly generations: Map<string, WorkspacePathCatalogGeneration>,
    protected readonly latestGenerationIds: Map<string, string>
  ) {}

  async spillResidentCatalog(
    key: string,
    generationId: string,
    requestedSpillDirectory?: string
  ): Promise<number> {
    const storeKey = workspacePathIndexWorkerGenerationKey(key, generationId)
    const generation = this.generations.get(storeKey)
    const spillDirectory = requestedSpillDirectory ?? this.spillDirectoryByRoot.get(key)
    if (!generation || generation.catalog.storageKind === 'disk-spilled' || !spillDirectory) {
      return 0
    }
    if (!this.preparedSpillDirectories.has(spillDirectory)) {
      const directoryHasLiveSpill = [...this.generations.values()].some(
        (candidate) =>
          candidate.catalog.storageKind === 'disk-spilled' &&
          dirname(candidate.catalog.spillFilePath) === spillDirectory
      )
      await cleanStaleWorkspacePathCatalogSpillDirectories(spillDirectory)
      if (!directoryHasLiveSpill) {
        await prepareWorkspacePathCatalogSpillDirectory(spillDirectory)
      }
      this.preparedSpillDirectories.add(spillDirectory)
    }
    this.spillDirectoryByRoot.set(key, spillDirectory)
    const originalCatalog = generation.catalog
    const spillRuns = new WorkspacePathCatalogSpillRuns(
      spillDirectory,
      key,
      generationId,
      undefined,
      dirname(spillDirectory)
    )
    try {
      if (!(await spillRuns.seedCatalog('included', originalCatalog))) {
        await spillRuns.cleanupScratch()
        return 0
      }
      const spilled = await spillRuns.finishAllScopes('all', generationId, originalCatalog.metadata)
      if (!spilled) {
        await spillRuns.cleanupScratch()
        return 0
      }
      const reclaimedBytes = originalCatalog.retainedBytes - spilled.catalog.retainedBytes
      if (reclaimedBytes <= 0) {
        await removeWorkspacePathCatalogSpill(spilled.catalog)
        await spillRuns.cleanupScratch()
        return 0
      }
      publishWorkspacePathIndexWorkerGeneration({
        generations: this.generations,
        latestGenerationIds: this.latestGenerationIds,
        rootKey: key,
        generationId,
        generation: { catalog: spilled.catalog }
      })
      await spillRuns.cleanupScratch()
      return reclaimedBytes
    } catch {
      await spillRuns.cleanupScratch()
      return 0
    }
  }

  protected async finishSpilledScope(
    build: ActiveBuild,
    pathSet: WorkspacePathSearchPathSet
  ): Promise<WorkspacePathIndexWorkerBuildResultBundle> {
    const spillRuns = build.spillRuns
    if (!spillRuns || !build.spillAvailable) {
      build.degradationReason = 'spill-unavailable'
      this.builds.delete(build.buildId)
      return createWorkspacePathIndexPartialBuildResult({
        buildId: build.buildId,
        readyScope: build.firstScope,
        generationId: build.catalog?.generationId ?? build.generationId,
        retainedBytes: build.catalog?.retainedBytes ?? 0,
        events: build.events,
        degradationReason: build.degradationReason
      })
    }
    try {
      if (!build.catalog) {
        if (pathSet !== build.firstScope) {
          throw new Error('Requested spill scope must be published first')
        }
        const spilled = await spillRuns.finishFirstScope(pathSet)
        if (!spilled) {
          throw new Error('Workspace path spill could not publish the first scope')
        }
        build.catalog = spilled.catalog
        publishWorkspacePathIndexWorkerGeneration({
          generations: this.generations,
          latestGenerationIds: this.latestGenerationIds,
          rootKey: build.key,
          generationId: build.generationId,
          generation: { catalog: spilled.catalog }
        })
        build.events.push({
          kind: 'degradation',
          correlationId: build.correlationId,
          reason: 'catalog-spilled'
        })
        return {
          build: {
            buildId: build.generationId,
            readyScope: build.firstScope,
            generationId: build.generationId,
            retainedBytes: spilled.catalog.retainedBytes,
            trigramPostingsBytes: 0,
            complete: false,
            storageMode: 'disk-spilled',
            spillFileBytes: spilled.fileBytes
          },
          events: build.events.splice(0)
        }
      }
      if (pathSet !== build.secondScope) {
        throw new Error('The other spill scope must follow the requested scope')
      }
      const generationId = `${build.generationId}:overlay`
      const spilled = await spillRuns.finishAllScopes(pathSet, generationId)
      if (!spilled) {
        throw new Error('Workspace path spill could not publish complete coverage')
      }
      if (build.cancelled || this.builds.get(build.buildId) !== build) {
        await removeWorkspacePathCatalogSpill(spilled.catalog)
        throw new Error('Workspace path catalog build was cancelled')
      }
      build.catalog = spilled.catalog
      publishWorkspacePathIndexWorkerGeneration({
        generations: this.generations,
        latestGenerationIds: this.latestGenerationIds,
        rootKey: build.key,
        generationId,
        generation: { catalog: spilled.catalog }
      })
      await spillRuns.cleanupScratch()
      this.builds.delete(build.buildId)
      build.events.push({
        kind: 'degradation',
        correlationId: build.correlationId,
        reason: 'catalog-spilled'
      })
      return {
        build: {
          buildId: build.buildId,
          readyScope: pathSet,
          generationId,
          retainedBytes: spilled.catalog.retainedBytes,
          trigramPostingsBytes: 0,
          complete: true,
          storageMode: 'disk-spilled',
          spillFileBytes: spilled.fileBytes
        },
        events: build.events.splice(0)
      }
    } catch {
      build.degradationReason = 'spill-unavailable'
      await spillRuns.cleanupScratch()
      this.builds.delete(build.buildId)
      build.events.push({
        kind: 'degradation',
        correlationId: build.correlationId,
        reason: 'spill-unavailable'
      })
      return createWorkspacePathIndexPartialBuildResult({
        buildId: build.buildId,
        readyScope: build.firstScope,
        generationId: build.catalog?.generationId ?? build.generationId,
        retainedBytes: build.catalog?.retainedBytes ?? 0,
        events: build.events,
        degradationReason: build.degradationReason
      })
    }
  }

  protected releaseLookup(build: ActiveBuild): void {
    build.builder.releasePathLookup()
  }

  protected requireBuild(buildId: string): ActiveBuild {
    const build = this.builds.get(buildId)
    if (!build) {
      throw new Error('Workspace path catalog build is unavailable')
    }
    return build
  }
}
