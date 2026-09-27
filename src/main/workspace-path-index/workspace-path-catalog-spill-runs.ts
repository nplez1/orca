import { rm } from 'node:fs/promises'
import {
  getWorkspacePathCatalogOriginalPath,
  type WorkspacePathCatalog,
  type WorkspacePathCatalogMetadata
} from '../../shared/workspace-path-catalog'
import type { DecodedWorkspacePathCatalogBlock } from '../../shared/workspace-path-catalog-blocks'
import type { WorkspacePathSearchPathSet } from '../../shared/workspace-path-search-contract'
import {
  removeWorkspacePathCatalogSpill,
  writeWorkspacePathCatalogSpill
} from './workspace-path-catalog-spill'
import {
  SPILL_DISK_BUDGET_BYTES,
  directorySizeBytes,
  isWithinDiskBudget
} from './workspace-path-catalog-spill-runs-disk-budget'
import { checkSpillCancelled } from './workspace-path-catalog-spill-runs-file-writer'
import {
  RUN_CHUNK_PATHS,
  WorkspacePathCatalogSpillRunsLifecycle
} from './workspace-path-catalog-spill-runs-lifecycle'
import {
  classifyCompleteCatalogRecords,
  countMergedRunRecords,
  mergeRunFiles
} from './workspace-path-catalog-spill-runs-merge'
import {
  completeScopeMetadata,
  firstScopeMetadata
} from './workspace-path-catalog-spill-runs-metadata'

/** Bounds build memory to one dedupe chunk and at most sixteen merge cursors. */
export class WorkspacePathCatalogSpillRuns extends WorkspacePathCatalogSpillRunsLifecycle {
  async finishFirstScope(
    pathSet: WorkspacePathSearchPathSet
  ): Promise<{ catalog: WorkspacePathCatalog; fileBytes: number } | null> {
    if (this.firstScope !== null) {
      throw new Error('Workspace path spill first scope was already finished')
    }
    this.firstScope = pathSet
    if (!(await this.flush(pathSet))) {
      return null
    }
    const group = this.scopeRuns[pathSet]
    const pathCount = await countMergedRunRecords(group.files, this.directory, this.cancellation)
    const metadata = firstScopeMetadata(pathSet, this.foldLocale)
    const availableDiskBytes =
      SPILL_DISK_BUDGET_BYTES - (await directorySizeBytes(this.budgetDirectory))
    if (availableDiskBytes <= 0) {
      return null
    }
    const written = await writeWorkspacePathCatalogSpill({
      directory: this.directory,
      identityKey: this.identityKey,
      generationId: this.generationId,
      metadata,
      pathCount,
      records: mergeRunFiles(group.files, this.directory, this.cancellation),
      cancellation: this.cancellation,
      maxDiskBytes: availableDiskBytes
    })
    if (!(await isWithinDiskBudget(this.budgetDirectory))) {
      await removeWorkspacePathCatalogSpill(written.catalog)
      return null
    }
    return written
  }

  async seedCatalog(
    pathSet: WorkspacePathSearchPathSet,
    catalog: Exclude<WorkspacePathCatalog, { storageKind: 'disk-spilled' }>
  ): Promise<boolean> {
    this.firstScope = pathSet
    for (let rank = 0; rank < catalog.pathCount; rank += 1) {
      checkSpillCancelled(this.cancellation)
      const pathId = catalog.naturalOrder[rank]
      if (pathId === undefined) {
        return false
      }
      const path = getWorkspacePathCatalogOriginalPath(catalog, pathId)
      if (!this.collectFlags(pathSet, path, catalog.flags[pathId] ?? 0)) {
        return false
      }
      if (this.scopeRuns[pathSet].pending.size >= RUN_CHUNK_PATHS && !(await this.flush(pathSet))) {
        return false
      }
    }
    return this.flush(pathSet)
  }

  async seedSpilledCatalog(
    pathSet: WorkspacePathSearchPathSet,
    catalog: Extract<WorkspacePathCatalog, { storageKind: 'disk-spilled' }>,
    readBlock: (blockIndex: number) => Promise<DecodedWorkspacePathCatalogBlock>,
    shouldSkip: (path: string, flags: number) => boolean
  ): Promise<boolean> {
    if (this.firstScope !== null) {
      throw new Error('Workspace path spill first scope was already seeded')
    }
    this.firstScope = pathSet
    for (let blockIndex = 0; blockIndex < catalog.spillBlockCount; blockIndex += 1) {
      checkSpillCancelled(this.cancellation)
      const block = await readBlock(blockIndex)
      for (let index = 0; index < block.originals.length; index += 1) {
        const path = block.originals[index]
        const flags = block.flags[index]
        if (path === undefined || flags === undefined) {
          return false
        }
        if (!shouldSkip(path, flags)) {
          if (!this.collectFlags(pathSet, path, flags)) {
            return false
          }
          if (
            this.scopeRuns[pathSet].pending.size >= RUN_CHUNK_PATHS &&
            !(await this.flush(pathSet))
          ) {
            return false
          }
        }
      }
    }
    return this.flush(pathSet)
  }

  async finishAllScopes(
    secondScope: WorkspacePathSearchPathSet,
    generationId: string,
    metadataOverride?: WorkspacePathCatalogMetadata
  ): Promise<{ catalog: WorkspacePathCatalog; fileBytes: number } | null> {
    const firstScope = this.firstScope
    if (!firstScope || firstScope === secondScope) {
      throw new Error('Workspace path spill needs both distinct scopes')
    }
    if (!(await this.flush(secondScope))) {
      return null
    }
    const files = [...this.scopeRuns[firstScope].files, ...this.scopeRuns[secondScope].files]
    const pathCount = await countMergedRunRecords(files, this.directory, this.cancellation)
    const metadata = metadataOverride ?? completeScopeMetadata(this.foldLocale)
    const merged = classifyCompleteCatalogRecords(
      mergeRunFiles(files, this.directory, this.cancellation),
      this.cancellation
    )
    const availableDiskBytes =
      SPILL_DISK_BUDGET_BYTES - (await directorySizeBytes(this.budgetDirectory))
    if (availableDiskBytes <= 0) {
      return null
    }
    const written = await writeWorkspacePathCatalogSpill({
      directory: this.directory,
      identityKey: this.identityKey,
      generationId,
      metadata,
      pathCount,
      records: merged,
      cancellation: this.cancellation,
      maxDiskBytes: availableDiskBytes
    })
    if (!(await isWithinDiskBudget(this.budgetDirectory))) {
      await removeWorkspacePathCatalogSpill(written.catalog)
      return null
    }
    return written
  }

  async cleanupScratch(): Promise<void> {
    await Promise.all([...this.scratchFiles].map((path) => rm(path, { force: true })))
    this.scratchFiles.clear()
    for (const group of Object.values(this.scopeRuns)) {
      group.files = []
      group.pending.clear()
    }
    this.finished = true
  }

  async cleanupAll(): Promise<void> {
    await Promise.all([...this.scratchFiles].map((path) => rm(path, { force: true })))
    this.scratchFiles.clear()
    const files = Object.values(this.scopeRuns).flatMap((group) =>
      group.files.map((file) => file.path)
    )
    await Promise.all(files.map((path) => rm(path, { force: true })))
    for (const group of Object.values(this.scopeRuns)) {
      group.files = []
      group.pending.clear()
    }
    this.finished = true
  }
}
