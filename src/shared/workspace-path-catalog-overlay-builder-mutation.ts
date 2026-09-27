import type { WorkspacePathSearchPathSet } from './workspace-path-search-contract'
import type {
  WorkspacePathSearchCorrelationId,
  WorkspacePathSearchInstrumentationEvent
} from './workspace-path-search-instrumentation'
import {
  isEligibleWorkspaceCatalogPath,
  normalizeWorkspaceRelativePath,
  workspacePathCatalogPathFlags,
  WORKSPACE_PATH_CATALOG_FLAGS,
  type WorkspacePathCatalog,
  type WorkspacePathCatalogMetadata
} from './workspace-path-catalog'
import { findWorkspacePathCatalogInsertionRank } from './workspace-path-catalog-ordering'
import type {
  WorkspacePathCatalogDeltaEntry,
  WorkspacePathCatalogOverlay,
  WorkspacePathCatalogOverlayBuilderOptions
} from './workspace-path-catalog-overlay-contract'
import { publishWorkspacePathCatalogOverlay } from './workspace-path-catalog-overlay-publication'
import {
  applyWorkspacePathCatalogOverlayBaseFlags,
  lookupWorkspacePathCatalogOverlayBasePathId,
  readWorkspacePathCatalogOverlayBaseFlags,
  tombstoneWorkspacePathCatalogOverlayBasePrefix
} from './workspace-path-catalog-overlay-base-mutation'
import { estimateWorkspacePathCatalogOverlayEntryReservation } from './workspace-path-catalog-overlay-admission'

/** Delta admission and mutation core; the public builder adds classification and publication. */
export abstract class WorkspacePathCatalogOverlayBuilderMutation {
  protected readonly base: WorkspacePathCatalog
  protected readonly generationId: string
  protected readonly maxBytes: number
  protected readonly findBasePathId?: (path: string) => number | undefined
  protected readonly onInstrumentation?: (event: WorkspacePathSearchInstrumentationEvent) => void
  protected readonly correlationId: WorkspacePathSearchCorrelationId
  protected readonly baseFlagAdditions: Uint8Array
  protected readonly baseFlagReplacements: Uint8Array
  protected readonly baseFlagReplacementKnown: Uint8Array
  protected readonly baseTombstones: Uint8Array
  protected readonly delta = new Map<string, WorkspacePathCatalogDeltaEntry>()
  protected metadata: WorkspacePathCatalogMetadata
  protected reservedBytes: number
  protected normalizationMilliseconds = 0
  protected overBudget = false
  protected finished = false

  constructor(base: WorkspacePathCatalog, options: WorkspacePathCatalogOverlayBuilderOptions) {
    this.base = base
    this.generationId = options.generationId
    this.maxBytes = Math.max(0, Math.floor(options.maxBytes))
    this.findBasePathId = options.findBasePathId
    this.onInstrumentation = options.onInstrumentation
    this.correlationId = options.correlationId ?? 'workspace-path-catalog-overlay'
    this.reservedBytes = base.pathCount * 4 + 128
    if (this.reservedBytes > this.maxBytes) {
      this.overBudget = true
    }
    const previous = options.previousOverlay
    this.baseFlagAdditions = this.overBudget
      ? new Uint8Array(0)
      : (previous?.baseFlagAdditions.slice() ?? new Uint8Array(base.pathCount))
    this.baseFlagReplacements = this.overBudget
      ? new Uint8Array(0)
      : (previous?.baseFlagReplacements.slice() ?? new Uint8Array(base.pathCount))
    this.baseFlagReplacementKnown = this.overBudget
      ? new Uint8Array(0)
      : (previous?.baseFlagReplacementKnown.slice() ?? new Uint8Array(base.pathCount))
    this.baseTombstones = this.overBudget
      ? new Uint8Array(0)
      : (previous?.baseTombstones.slice() ?? new Uint8Array(base.pathCount))
    this.metadata = { ...(previous?.metadata ?? base.metadata) }
    for (const entry of previous?.delta ?? []) {
      this.delta.set(entry.relativePath, { ...entry })
    }
    this.reservedBytes += previous?.deltaBytes ?? 0
    if (this.reservedBytes > this.maxBytes) {
      this.overBudget = true
    }
  }

  get isOverBudget(): boolean {
    return this.overBudget
  }

  get deltaPathCount(): number {
    return this.delta.size
  }

  get admissionBytes(): number {
    return this.reservedBytes
  }

  addPath(path: string, pathSet: WorkspacePathSearchPathSet): boolean {
    return this.applyPath(path, 0, pathSet, false)
  }

  upsertPath(path: string, flags: number): boolean {
    return this.applyPath(path, flags, undefined, true)
  }

  private applyPath(
    path: string,
    flags: number,
    pathSet: WorkspacePathSearchPathSet | undefined,
    replace: boolean
  ): boolean {
    if (this.finished || this.overBudget) {
      return false
    }
    const reserve = estimateWorkspacePathCatalogOverlayEntryReservation(path)
    if (!this.reserve(reserve)) {
      return false
    }
    const normalizationStartedAt = performance.now()
    const normalized = normalizeWorkspaceRelativePath(path)
    if (!isEligibleWorkspaceCatalogPath(normalized)) {
      this.reservedBytes -= reserve
      this.normalizationMilliseconds += performance.now() - normalizationStartedAt
      return true
    }
    const baseId = this.lookupBasePathId(normalized)
    const existingDelta = this.delta.get(normalized)
    let effectiveFlags = pathSet ? workspacePathCatalogPathFlags(normalized, pathSet) : flags
    if (pathSet === 'all' && this.metadata.classificationComplete) {
      const existingFlags =
        baseId === undefined
          ? (existingDelta?.flags ?? 0)
          : readWorkspacePathCatalogOverlayBaseFlags({
              pathId: baseId,
              baseFlags: this.base.flags,
              flagAdditions: this.baseFlagAdditions,
              flagReplacements: this.baseFlagReplacements,
              flagReplacementKnown: this.baseFlagReplacementKnown
            })
      effectiveFlags |= WORKSPACE_PATH_CATALOG_FLAGS.ignoreClassificationKnown
      if ((existingFlags & WORKSPACE_PATH_CATALOG_FLAGS.included) === 0) {
        effectiveFlags |= WORKSPACE_PATH_CATALOG_FLAGS.ignored
      }
    }
    if (baseId !== undefined) {
      applyWorkspacePathCatalogOverlayBaseFlags({
        pathId: baseId,
        effectiveFlags,
        replace,
        flagAdditions: this.baseFlagAdditions,
        flagReplacements: this.baseFlagReplacements,
        flagReplacementKnown: this.baseFlagReplacementKnown,
        tombstones: this.baseTombstones
      })
      this.reservedBytes -= reserve
      this.normalizationMilliseconds += performance.now() - normalizationStartedAt
      return true
    }
    const existing = existingDelta
    if (existing) {
      existing.flags = replace ? effectiveFlags : existing.flags | effectiveFlags
      this.reservedBytes -= reserve
      this.normalizationMilliseconds += performance.now() - normalizationStartedAt
      return true
    }
    const foldedPath = normalized.toLocaleLowerCase(this.base.metadata.foldLocale)
    const baseRank = findWorkspacePathCatalogInsertionRank(this.base, normalized)
    this.delta.set(normalized, {
      relativePath: normalized,
      foldedPath,
      flags: effectiveFlags,
      baseRank
    })
    this.normalizationMilliseconds += performance.now() - normalizationStartedAt
    return true
  }
  deletePath(path: string): boolean {
    if (this.finished || this.overBudget) {
      return false
    }
    const normalized = normalizeWorkspaceRelativePath(path)
    const baseId = this.lookupBasePathId(normalized)
    if (baseId !== undefined) {
      this.baseTombstones[baseId] = 1
      return true
    }
    this.delta.delete(normalized)
    return true
  }

  deletePathPrefix(path: string): boolean {
    if (this.finished || this.overBudget) {
      return false
    }
    const prefix = normalizeWorkspaceRelativePath(path).replace(/\/+$/, '')
    if (!prefix) {
      return false
    }
    const boundaryPrefix = `${prefix}/`
    tombstoneWorkspacePathCatalogOverlayBasePrefix({
      base: this.base,
      prefix,
      tombstones: this.baseTombstones
    })
    for (const candidate of this.delta.keys()) {
      if (candidate === prefix || candidate.startsWith(boundaryPrefix)) {
        this.delta.delete(candidate)
      }
    }
    return true
  }

  protected publishSortedDelta(
    sortedDelta: WorkspacePathCatalogDeltaEntry[]
  ): WorkspacePathCatalogOverlay {
    return publishWorkspacePathCatalogOverlay({
      generationId: this.generationId,
      metadata: this.metadata,
      baseFlagAdditions: this.baseFlagAdditions,
      baseFlagReplacements: this.baseFlagReplacements,
      baseFlagReplacementKnown: this.baseFlagReplacementKnown,
      baseTombstones: this.baseTombstones,
      delta: this.delta,
      sortedDelta,
      correlationId: this.correlationId,
      onInstrumentation: this.onInstrumentation
    })
  }
  private lookupBasePathId(path: string): number | undefined {
    return lookupWorkspacePathCatalogOverlayBasePathId({
      base: this.base,
      path,
      findBasePathId: this.findBasePathId
    })
  }
  private reserve(bytes: number): boolean {
    if (this.reservedBytes + bytes > this.maxBytes) {
      this.overBudget = true
      return false
    }
    this.reservedBytes += bytes
    return true
  }
}
