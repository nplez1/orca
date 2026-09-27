import {
  WORKSPACE_PATH_CATALOG_FOLD_VERSION,
  type WorkspacePathCatalog,
  type WorkspacePathCatalogMetadata
} from './workspace-path-catalog'
import type {
  WorkspacePathSearchCorrelationId,
  WorkspacePathSearchInstrumentationEvent
} from './workspace-path-search-instrumentation'
import { publishWorkspacePathCatalog } from './workspace-path-catalog-builder-publication'
import { sortWorkspacePathCatalogRecords } from './workspace-path-catalog-builder-sort'
import type { WorkspacePathSortCancellation } from './workspace-path-stable-sort'
import {
  WorkspacePathCatalogBuilderCollection,
  type WorkspacePathCatalogBuildRecord,
  type WorkspacePathCatalogStorage
} from './workspace-path-catalog-builder-collection'

export type {
  WorkspacePathCatalogBuildRecord,
  WorkspacePathCatalogBuilderOptions,
  WorkspacePathCatalogStorage
} from './workspace-path-catalog-builder-collection'

/** Publishes the immutable packed catalog built by the collection lane. */
export class WorkspacePathCatalogBuilder extends WorkspacePathCatalogBuilderCollection {
  async sortNaturalOrderInWorker(
    options: {
      retainPathLookup?: boolean
      cancellation?: WorkspacePathSortCancellation
    } = {}
  ): Promise<Uint32Array | null> {
    return sortWorkspacePathCatalogRecords({
      records: this.records,
      storage: this.storage,
      originalUtf8Length: this.originalUtf8Length,
      foldedCodeUnitCount: this.foldedCodeUnitCount,
      retainedLookupBytes: options.retainPathLookup ? this.lookupRetainedBytes : 0,
      reservedBuildBytes: this.reservedBytes,
      maxBytes: this.maxBytes,
      correlationId: this.correlationId,
      onInstrumentation: this.onInstrumentation,
      cancellation: options.cancellation
    }).then((naturalOrder) => {
      if (!naturalOrder) {
        this.overBudget = true
      }
      return naturalOrder
    })
  }

  workerPublicationState(retainedLookupBytes: number): {
    records: readonly WorkspacePathCatalogBuildRecord[]
    generationId: string
    storage: WorkspacePathCatalogStorage
    metadata: WorkspacePathCatalogMetadata
    originalUtf8Length: number
    foldedCodeUnitCount: number
    retainedLookupBytes: number
    reservedBuildBytes: number
    maxBytes: number
    correlationId: WorkspacePathSearchCorrelationId
    onInstrumentation?: (event: WorkspacePathSearchInstrumentationEvent) => void
  } {
    return {
      records: this.records,
      generationId: this.generationId,
      storage: this.storage,
      metadata: this.metadata(),
      originalUtf8Length: this.originalUtf8Length,
      foldedCodeUnitCount: this.foldedCodeUnitCount,
      retainedLookupBytes,
      reservedBuildBytes: this.reservedBytes,
      maxBytes: this.maxBytes,
      correlationId: this.correlationId,
      onInstrumentation: this.onInstrumentation
    }
  }

  completeWorkerPublication(
    catalog: WorkspacePathCatalog,
    retainedLookupBytes: number,
    retainPathLookup: boolean
  ): void {
    this.finished = true
    this.storePublishedCatalog(catalog, retainedLookupBytes, retainPathLookup)
  }

  markWorkerPublicationFailed(): void {
    this.overBudget = true
  }

  finish(
    options: { retainPathLookup?: boolean; naturalOrder?: Uint32Array } = {}
  ): WorkspacePathCatalog | null {
    if (this.finished || this.overBudget) {
      return null
    }
    const retainedLookupBytes = options.retainPathLookup ? this.lookupRetainedBytes : 0
    this.finished = true
    this.emitStage('normalization', this.normalizationMilliseconds)
    const catalog = publishWorkspacePathCatalog({
      records: this.records,
      generationId: this.generationId,
      storage: this.storage,
      metadata: this.metadata(),
      originalUtf8Length: this.originalUtf8Length,
      foldedCodeUnitCount: this.foldedCodeUnitCount,
      retainedLookupBytes,
      reservedBuildBytes: this.reservedBytes,
      maxBytes: this.maxBytes,
      ...(options.naturalOrder ? { naturalOrder: options.naturalOrder } : {}),
      correlationId: this.correlationId,
      onInstrumentation: this.onInstrumentation
    })
    if (!catalog) {
      this.overBudget = true
      return null
    }
    this.storePublishedCatalog(catalog, retainedLookupBytes, options.retainPathLookup ?? false)
    return catalog
  }

  private storePublishedCatalog(
    catalog: WorkspacePathCatalog,
    retainedLookupBytes: number,
    retainPathLookup: boolean
  ): void {
    this.reservedBytes = catalog.retainedBytes + retainedLookupBytes
    this.lookupBytes = retainedLookupBytes
    this.records = []
    if (!retainPathLookup) {
      this.pathIds.clear()
      this.pathIds = new Map<string, number>()
    }
  }

  private metadata(): WorkspacePathCatalogMetadata {
    return {
      foldLocale: this.foldLocale,
      foldVersion: WORKSPACE_PATH_CATALOG_FOLD_VERSION,
      scopeRuleVersion: this.scopeRuleVersion,
      includedComplete: this.includedComplete,
      allComplete: this.allComplete,
      classificationComplete: this.classificationComplete,
      coverageExcludePathSegments: this.coverageExcludePathSegments,
      freshness: this.freshness
    }
  }
}
