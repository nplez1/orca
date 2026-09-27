import type { WorkspacePathSearchPathSet } from './workspace-path-search-contract'
import {
  addWorkspacePathCatalogBatch,
  classifyWorkspacePathCatalogRecords,
  estimateWorkspacePathCatalogLookupBytes,
  estimateWorkspacePathCatalogPathReservation
} from './workspace-path-catalog-builder-admission'
import type {
  WorkspacePathSearchCorrelationId,
  WorkspacePathSearchInstrumentationEvent
} from './workspace-path-search-instrumentation'
import {
  isEligibleWorkspaceCatalogPath,
  normalizeWorkspaceRelativePath,
  resolveWorkspacePathFoldLocale,
  WORKSPACE_PATH_CATALOG_SCOPE_RULE_VERSION,
  workspacePathCatalogPathFlags
} from './workspace-path-catalog'

export type WorkspacePathCatalogStorage = 'folded-strings' | 'packed-folded' | 'prefix-compressed'

export type WorkspacePathCatalogBuilderOptions = {
  generationId: string
  maxBytes: number
  storage?: WorkspacePathCatalogStorage
  foldLocale?: string
  scopeRuleVersion?: string
  onInstrumentation?: (event: WorkspacePathSearchInstrumentationEvent) => void
  correlationId?: WorkspacePathSearchCorrelationId
  freshness?: string
  coverageExcludePathSegments?: readonly (readonly string[])[]
}

export type WorkspacePathCatalogBuildRecord = {
  relativePath: string
  foldedPath: string
  originalUtf8Length: number
  flags: number
}

/** Owns normalized/folded path records and incremental scope membership. */
export class WorkspacePathCatalogBuilderCollection {
  readonly foldLocale: string
  readonly storage: WorkspacePathCatalogStorage
  protected readonly maxBytes: number
  protected readonly generationId: string
  protected readonly scopeRuleVersion: string
  protected readonly freshness: string
  protected readonly coverageExcludePathSegments: readonly (readonly string[])[]
  protected readonly onInstrumentation?: (event: WorkspacePathSearchInstrumentationEvent) => void
  protected readonly correlationId: WorkspacePathSearchCorrelationId
  protected records: WorkspacePathCatalogBuildRecord[] = []
  protected pathIds = new Map<string, number>()
  protected reservedBytes = 0
  protected lookupBytes = 0
  protected normalizationMilliseconds = 0
  protected originalUtf8Length = 0
  protected foldedCodeUnitCount = 0
  protected includedComplete = false
  protected allComplete = false
  protected classificationComplete = false
  protected finished = false
  protected overBudget = false

  constructor(options: WorkspacePathCatalogBuilderOptions) {
    this.generationId = options.generationId
    this.maxBytes = Math.max(0, Math.floor(options.maxBytes))
    this.storage = options.storage ?? 'folded-strings'
    this.foldLocale = options.foldLocale ?? resolveWorkspacePathFoldLocale()
    this.scopeRuleVersion = options.scopeRuleVersion ?? WORKSPACE_PATH_CATALOG_SCOPE_RULE_VERSION
    this.freshness = options.freshness ?? 'unknown'
    this.coverageExcludePathSegments =
      options.coverageExcludePathSegments?.map((segments) => [...segments]) ?? []
    this.onInstrumentation = options.onInstrumentation
    this.correlationId = options.correlationId ?? 'workspace-path-catalog-build'
  }

  get pathCount(): number {
    return this.records.length
  }

  get admissionBytes(): number {
    return this.reservedBytes
  }

  get isOverBudget(): boolean {
    return this.overBudget
  }

  get lookupRetainedBytes(): number {
    return this.finished ? this.lookupBytes : estimateWorkspacePathCatalogLookupBytes(this.records)
  }

  addPath(path: string, pathSet: WorkspacePathSearchPathSet): boolean {
    if (this.finished || this.overBudget) {
      return false
    }
    const reserve = estimateWorkspacePathCatalogPathReservation(path, this.storage)
    if (!this.reserve(reserve)) {
      return false
    }
    const normalizationStartedAt = performance.now()
    const normalized = normalizeWorkspaceRelativePath(path)
    if (!isEligibleWorkspaceCatalogPath(normalized)) {
      this.normalizationMilliseconds += performance.now() - normalizationStartedAt
      this.reservedBytes -= reserve
      return true
    }
    const existingId = this.pathIds.get(normalized)
    if (existingId !== undefined) {
      const existing = this.records[existingId]
      if (existing) {
        existing.flags |= workspacePathCatalogPathFlags(normalized, pathSet)
      }
      this.reservedBytes -= reserve
      this.normalizationMilliseconds += performance.now() - normalizationStartedAt
      return true
    }
    if (this.records.length >= 0xffff_ffff) {
      this.reservedBytes -= reserve
      this.overBudget = true
      return false
    }
    const foldedPath = normalized.toLocaleLowerCase(this.foldLocale)
    const originalUtf8Length = new TextEncoder().encode(normalized).length
    this.originalUtf8Length += originalUtf8Length
    this.foldedCodeUnitCount += foldedPath.length
    const id = this.records.length
    this.records.push({
      relativePath: normalized,
      foldedPath,
      originalUtf8Length,
      flags: workspacePathCatalogPathFlags(normalized, pathSet)
    })
    this.pathIds.set(normalized, id)
    this.normalizationMilliseconds += performance.now() - normalizationStartedAt
    return true
  }

  addPreFoldedPath(path: string, foldedPath: string, flags: number): boolean {
    if (this.finished || this.overBudget) {
      return false
    }
    const reserve = estimateWorkspacePathCatalogPathReservation(path, this.storage)
    if (!this.reserve(reserve)) {
      return false
    }
    const normalizationStartedAt = performance.now()
    const normalized = normalizeWorkspaceRelativePath(path)
    if (!isEligibleWorkspaceCatalogPath(normalized)) {
      this.reservedBytes -= reserve
      return true
    }
    const existingId = this.pathIds.get(normalized)
    if (existingId !== undefined) {
      const existing = this.records[existingId]
      if (existing) {
        existing.flags |= flags
      }
      this.reservedBytes -= reserve
      return true
    }
    const originalUtf8Length = new TextEncoder().encode(normalized).length
    const id = this.records.length
    this.records.push({ relativePath: normalized, foldedPath, originalUtf8Length, flags })
    this.pathIds.set(normalized, id)
    this.originalUtf8Length += originalUtf8Length
    this.foldedCodeUnitCount += foldedPath.length
    this.normalizationMilliseconds += performance.now() - normalizationStartedAt
    return true
  }

  addBatch(paths: Iterable<string>, pathSet: WorkspacePathSearchPathSet): boolean {
    return addWorkspacePathCatalogBatch(paths, pathSet, (path, scope) => this.addPath(path, scope))
  }

  markScopeComplete(pathSet: WorkspacePathSearchPathSet): void {
    if (pathSet === 'included') {
      this.includedComplete = true
    } else {
      this.allComplete = true
    }
    this.classificationComplete = this.includedComplete && this.allComplete
  }

  completeClassification(): void {
    this.classificationComplete = classifyWorkspacePathCatalogRecords(
      this.records,
      this.includedComplete,
      this.allComplete
    )
  }

  findPathId(path: string): number | undefined {
    return this.pathIds.get(normalizeWorkspaceRelativePath(path))
  }

  releasePathLookup(): void {
    this.pathIds.clear()
    this.pathIds = new Map<string, number>()
    this.lookupBytes = 0
    this.reservedBytes = 0
  }

  takeBuildRecordsForSpill(): WorkspacePathCatalogBuildRecord[] {
    const records = this.records
    this.records = []
    this.pathIds.clear()
    this.pathIds = new Map<string, number>()
    this.lookupBytes = 0
    this.reservedBytes = 0
    this.finished = true
    return records
  }

  protected reserve(bytes: number): boolean {
    if (this.reservedBytes + bytes > this.maxBytes) {
      this.overBudget = true
      return false
    }
    this.reservedBytes += bytes
    return true
  }

  protected emitStage(stage: 'normalization' | 'sort', milliseconds: number): void {
    this.onInstrumentation?.({
      kind: 'stage-timing',
      record: {
        correlationId: this.correlationId,
        stage,
        duration: { milliseconds, clock: 'execution-host-monotonic' }
      }
    })
  }
}
