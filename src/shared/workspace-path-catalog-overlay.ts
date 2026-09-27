import { compareFileNames } from './file-name-sort'
import type { WorkspacePathSearchPathSet } from './workspace-path-search-contract'
import {
  classifyWorkspacePathCatalogOverlay,
  classifyWorkspacePathCatalogOverlayInWorker
} from './workspace-path-catalog-compaction'
import { emitWorkspacePathCatalogOverlayStage } from './workspace-path-catalog-overlay-admission'
import type { WorkspacePathCatalogOverlay } from './workspace-path-catalog-overlay-contract'
import { WorkspacePathCatalogOverlayBuilderMutation } from './workspace-path-catalog-overlay-builder-mutation'
import {
  stableSortWorkspacePathValues,
  type WorkspacePathSortCancellation
} from './workspace-path-stable-sort'

export * from './workspace-path-catalog-compaction'
export type * from './workspace-path-catalog-overlay-contract'
export { findWorkspacePathCatalogInsertionRank } from './workspace-path-catalog-ordering'

/** Mutable, transactional delta builder; callers publish only its completed immutable result. */
export class WorkspacePathCatalogOverlayBuilder extends WorkspacePathCatalogOverlayBuilderMutation {
  setFreshness(freshness: string): void {
    this.metadata.freshness = freshness
  }

  markScopeComplete(pathSet: WorkspacePathSearchPathSet): void {
    if (pathSet === 'included') {
      this.metadata.includedComplete = true
    } else {
      this.metadata.allComplete = true
    }
    this.metadata.classificationComplete =
      this.metadata.includedComplete && this.metadata.allComplete
  }
  completeClassification(): void {
    if (!this.metadata.includedComplete || !this.metadata.allComplete) {
      return
    }
    classifyWorkspacePathCatalogOverlay({
      catalog: this.base,
      flagAdditions: this.baseFlagAdditions,
      flagReplacements: this.baseFlagReplacements,
      replacementKnown: this.baseFlagReplacementKnown,
      delta: this.delta.values()
    })
    this.metadata.classificationComplete = true
  }
  async completeClassificationInWorker(
    cancellation?: WorkspacePathSortCancellation
  ): Promise<void> {
    if (!this.metadata.includedComplete || !this.metadata.allComplete) {
      return
    }
    await classifyWorkspacePathCatalogOverlayInWorker({
      catalog: this.base,
      flagAdditions: this.baseFlagAdditions,
      flagReplacements: this.baseFlagReplacements,
      replacementKnown: this.baseFlagReplacementKnown,
      delta: this.delta.values(),
      cancellation
    })
    this.metadata.classificationComplete = true
  }
  finish(): WorkspacePathCatalogOverlay | null {
    if (this.finished || this.overBudget) {
      return null
    }
    this.finished = true
    emitWorkspacePathCatalogOverlayStage({
      onInstrumentation: this.onInstrumentation,
      correlationId: this.correlationId,
      stage: 'normalization',
      milliseconds: this.normalizationMilliseconds
    })
    const sortStartedAt = performance.now()
    const sortedDelta = [...this.delta.values()].sort((left, right) =>
      compareFileNames(left.relativePath, right.relativePath)
    )
    emitWorkspacePathCatalogOverlayStage({
      onInstrumentation: this.onInstrumentation,
      correlationId: this.correlationId,
      stage: 'sort',
      milliseconds: performance.now() - sortStartedAt
    })
    return this.publishSortedDelta(sortedDelta)
  }
  async finishInWorker(
    cancellation?: WorkspacePathSortCancellation
  ): Promise<WorkspacePathCatalogOverlay | null> {
    if (this.finished || this.overBudget) {
      return null
    }
    this.finished = true
    emitWorkspacePathCatalogOverlayStage({
      onInstrumentation: this.onInstrumentation,
      correlationId: this.correlationId,
      stage: 'normalization',
      milliseconds: this.normalizationMilliseconds
    })
    const sortStartedAt = performance.now()
    const sortedDelta = await stableSortWorkspacePathValues(
      [...this.delta.values()],
      (left, right) => compareFileNames(left.relativePath, right.relativePath),
      cancellation
    )
    emitWorkspacePathCatalogOverlayStage({
      onInstrumentation: this.onInstrumentation,
      correlationId: this.correlationId,
      stage: 'sort',
      milliseconds: performance.now() - sortStartedAt
    })
    return this.publishSortedDelta(sortedDelta)
  }
}
