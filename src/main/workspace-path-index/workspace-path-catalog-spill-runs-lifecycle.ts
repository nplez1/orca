import { rm } from 'node:fs/promises'
import {
  isEligibleWorkspaceCatalogPath,
  normalizeWorkspaceRelativePath,
  resolveWorkspacePathFoldLocale,
  workspacePathCatalogPathFlags
} from '../../shared/workspace-path-catalog'
import { compareFileNames } from '../../shared/file-name-sort'
import type { WorkspacePathCatalogBuildRecord } from '../../shared/workspace-path-catalog-builder-collection'
import type { WorkspacePathSearchPathSet } from '../../shared/workspace-path-search-contract'
import { isWithinDiskBudget } from './workspace-path-catalog-spill-runs-disk-budget'
import {
  checkSpillCancelled,
  writeRunFile,
  writeRunFileFromIterator,
  type RunFile
} from './workspace-path-catalog-spill-runs-file-writer'
import {
  RUN_MERGE_FAN_IN,
  canMergeRunFiles,
  mergeRunFiles,
  nextFullRunLevel
} from './workspace-path-catalog-spill-runs-merge'

export type RunGroup = { files: RunFile[]; pending: Map<string, number> }

export const RUN_CHUNK_PATHS = 4_096

/** Dedupe-chunk admission and bounded run merging for the spill-run writer. */
export abstract class WorkspacePathCatalogSpillRunsLifecycle {
  protected readonly scopeRuns: Record<WorkspacePathSearchPathSet, RunGroup> = {
    included: { files: [], pending: new Map() },
    all: { files: [], pending: new Map() }
  }
  protected readonly foldLocale = resolveWorkspacePathFoldLocale()
  protected readonly scratchFiles = new Set<string>()
  protected readonly budgetDirectory: string
  protected firstScope: WorkspacePathSearchPathSet | null = null
  protected finished = false

  constructor(
    protected readonly directory: string,
    protected readonly identityKey: string,
    protected readonly generationId: string,
    protected readonly cancellation?: { isCancelled: () => boolean },
    budgetDirectory = directory
  ) {
    this.budgetDirectory = budgetDirectory
  }

  async addBatch(pathSet: WorkspacePathSearchPathSet, paths: readonly string[]): Promise<boolean> {
    for (const path of paths) {
      const normalized = normalizeWorkspaceRelativePath(path)
      if (
        !this.collectFlags(
          pathSet,
          normalized,
          workspacePathCatalogPathFlagsForSet(normalized, pathSet)
        )
      ) {
        return false
      }
      if (this.scopeRuns[pathSet].pending.size >= RUN_CHUNK_PATHS && !(await this.flush(pathSet))) {
        return false
      }
    }
    return true
  }

  async addBuildRecords(
    pathSet: WorkspacePathSearchPathSet,
    records: readonly WorkspacePathCatalogBuildRecord[]
  ): Promise<boolean> {
    for (const record of records) {
      if (!this.collectFlags(pathSet, record.relativePath, record.flags)) {
        return false
      }
      if (this.scopeRuns[pathSet].pending.size >= RUN_CHUNK_PATHS && !(await this.flush(pathSet))) {
        return false
      }
    }
    return true
  }

  async addFlags(
    pathSet: WorkspacePathSearchPathSet,
    path: string,
    flags: number
  ): Promise<boolean> {
    if (!this.collectFlags(pathSet, path, flags)) {
      return false
    }
    return this.scopeRuns[pathSet].pending.size < RUN_CHUNK_PATHS || this.flush(pathSet)
  }

  protected collectFlags(
    pathSet: WorkspacePathSearchPathSet,
    path: string,
    flags: number
  ): boolean {
    if (this.finished) {
      return false
    }
    const normalized = normalizeWorkspaceRelativePath(path)
    if (!isEligibleWorkspaceCatalogPath(normalized)) {
      return true
    }
    const group = this.scopeRuns[pathSet]
    group.pending.set(normalized, (group.pending.get(normalized) ?? 0) | flags)
    return true
  }

  protected async flush(pathSet: WorkspacePathSearchPathSet): Promise<boolean> {
    const group = this.scopeRuns[pathSet]
    if (group.pending.size === 0) {
      return true
    }
    checkSpillCancelled(this.cancellation)
    const records = [...group.pending.entries()]
      .map(([relativePath, flags]) => ({ relativePath, flags }))
      .sort((left, right) => compareFileNames(left.relativePath, right.relativePath))
    group.pending.clear()
    const run = await writeRunFile(
      this.directory,
      records,
      this.foldLocale,
      this.cancellation,
      this.budgetDirectory
    )
    group.files.push(run)
    this.scratchFiles.add(run.path)
    if (!(await isWithinDiskBudget(this.budgetDirectory))) {
      return false
    }
    while (true) {
      const level = nextFullRunLevel(group.files)
      if (level === null) {
        return true
      }
      const mergedInputs = group.files
        .filter((file) => file.level === level)
        .slice(0, RUN_MERGE_FAN_IN)
      if (!(await canMergeRunFiles(this.budgetDirectory, mergedInputs))) {
        return false
      }
      const inputs = new Set(mergedInputs)
      group.files = group.files.filter((file) => !inputs.has(file))
      const mergedRecords = mergeRunFiles(mergedInputs, this.directory, this.cancellation)
      const merged = await writeRunFileFromIterator(
        this.directory,
        mergedRecords,
        this.foldLocale,
        this.cancellation,
        level + 1,
        this.budgetDirectory
      )
      for (const input of mergedInputs) {
        await rm(input.path, { force: true })
        this.scratchFiles.delete(input.path)
      }
      group.files.push(merged)
      this.scratchFiles.add(merged.path)
      if (!(await isWithinDiskBudget(this.budgetDirectory))) {
        return false
      }
    }
  }
}

export function workspacePathCatalogPathFlagsForSet(
  path: string,
  pathSet: WorkspacePathSearchPathSet
): number {
  return workspacePathCatalogPathFlags(path, pathSet)
}
