import { dirname } from 'node:path'
import {
  normalizeWorkspaceRelativePath,
  workspacePathCatalogPathFlags,
  type WorkspacePathCatalog,
  type WorkspacePathCatalogGeneration,
  type WorkspacePathCatalogMetadata
} from '../../shared/workspace-path-catalog'
import type { WorkspacePathSearchInstrumentationEvent } from '../../shared/workspace-path-search-instrumentation'
import {
  openWorkspacePathCatalogSpillReader,
  removeWorkspacePathCatalogSpill
} from './workspace-path-catalog-spill'
import { WorkspacePathCatalogSpillRuns } from './workspace-path-catalog-spill-runs'
import { publishWorkspacePathIndexWorkerGeneration } from './workspace-path-index-worker-generation'
import type {
  WorkspacePathIndexDeltaMutation,
  WorkspacePathIndexWorkerResponse
} from './workspace-path-index-worker-protocol'

type SpilledPathMutation = {
  sequence: number
  kind: 'add' | 'upsert' | 'delete'
  flags: number
  preserveBaseFlags: boolean
}

type SpilledDeltaRequest = {
  id: number
  key: string
  expectedGenerationId: string
  generationId: string
  mutations: readonly WorkspacePathIndexDeltaMutation[]
  freshness: string
  correlationId: string
}

type SpilledDeltaDependencies = {
  generations: Map<string, WorkspacePathCatalogGeneration>
  latestGenerationIds: Map<string, string>
}

/** Rebuilds a spilled generation by sorted disk merge; delta state stays bounded to the event batch. */
export async function applyWorkspacePathIndexSpilledDelta(
  request: SpilledDeltaRequest,
  dependencies: SpilledDeltaDependencies,
  catalog: Extract<WorkspacePathCatalog, { storageKind: 'disk-spilled' }>
): Promise<WorkspacePathIndexWorkerResponse> {
  const startedAt = performance.now()
  const mutations = new Map<string, SpilledPathMutation>()
  const deletedPrefixes = new WorkspacePathSpillDeletePrefixIndex()
  let sequence = 0
  let mutationBytes = 0
  for (const mutation of request.mutations) {
    sequence += 1
    if (mutation.type === 'delete-prefix') {
      deletedPrefixes.add(normalizeSpillPrefix(mutation.path), sequence)
      continue
    }
    const path = normalizeWorkspaceRelativePath(mutation.path)
    mutationBytes += Buffer.byteLength(path, 'utf8') + 16
    if (mutation.type === 'delete') {
      mutations.set(path, {
        sequence,
        kind: 'delete',
        flags: 0,
        preserveBaseFlags: false
      })
      continue
    }
    const additionFlags =
      mutation.type === 'add'
        ? workspacePathCatalogPathFlags(path, mutation.pathSet)
        : mutation.flags
    const existing = mutations.get(path)
    if (mutation.type === 'add') {
      mutations.set(path, {
        sequence,
        kind: 'add',
        flags:
          (existing?.kind === 'add' || existing?.kind === 'upsert' ? existing.flags : 0) |
          additionFlags,
        preserveBaseFlags: existing
          ? existing.kind === 'delete' || (existing.kind === 'add' && existing.preserveBaseFlags)
          : true
      })
    } else {
      mutations.set(path, {
        sequence,
        kind: 'upsert',
        flags: additionFlags,
        preserveBaseFlags: false
      })
    }
  }

  let replacementCatalog: WorkspacePathCatalog | null = null
  const spillRuns = new WorkspacePathCatalogSpillRuns(
    dirname(catalog.spillFilePath),
    request.key,
    request.generationId,
    undefined,
    dirname(dirname(catalog.spillFilePath))
  )
  try {
    const reader = await openWorkspacePathCatalogSpillReader(catalog)
    try {
      const seeded = await spillRuns.seedSpilledCatalog(
        'included',
        catalog,
        reader.readBlock,
        (path, flags) => {
          const mutation = mutations.get(path)
          const prefixSequence = deletedPrefixes.latestSequence(path)
          if (mutation && mutation.sequence > prefixSequence) {
            if (mutation.kind === 'add' && mutation.preserveBaseFlags && prefixSequence < 0) {
              mutation.flags |= flags
            }
            return true
          }
          return prefixSequence >= 0 || mutation !== undefined
        }
      )
      if (!seeded) {
        throw new Error('Spilled generation could not be copied into its replacement build')
      }
    } finally {
      await reader.close()
    }

    for (const [path, mutation] of mutations) {
      if (
        (mutation.kind === 'add' || mutation.kind === 'upsert') &&
        mutation.sequence > deletedPrefixes.latestSequence(path)
      ) {
        if (!(await spillRuns.addFlags('all', path, mutation.flags))) {
          throw new Error('Spilled delta exceeded its build-run budget')
        }
      }
    }
    const metadata: WorkspacePathCatalogMetadata = {
      ...catalog.metadata,
      freshness: request.freshness
    }
    const replacement = await spillRuns.finishAllScopes('all', request.generationId, metadata)
    if (!replacement) {
      throw new Error('Spilled delta could not be atomically published')
    }
    replacementCatalog = replacement.catalog
    if (dependencies.latestGenerationIds.get(request.key) !== request.expectedGenerationId) {
      throw new Error('Workspace path index delta generation was superseded before publication')
    }
    publishWorkspacePathIndexWorkerGeneration({
      generations: dependencies.generations,
      latestGenerationIds: dependencies.latestGenerationIds,
      rootKey: request.key,
      generationId: request.generationId,
      generation: { catalog: replacement.catalog }
    })
    await spillRuns.cleanupScratch()
    const events: WorkspacePathSearchInstrumentationEvent[] = [
      {
        kind: 'maintenance',
        record: {
          correlationId: request.correlationId,
          action: 'delta-applied',
          pathCount: request.mutations.length,
          byteCount: mutationBytes,
          durationMilliseconds: performance.now() - startedAt,
          reason: 'disk-spilled-rebuild'
        }
      },
      {
        kind: 'maintenance',
        record: {
          correlationId: request.correlationId,
          action: 'compaction-triggered',
          pathCount: request.mutations.length,
          byteCount: mutationBytes,
          durationMilliseconds: 0,
          reason: 'disk-spilled-rebuild'
        }
      }
    ]
    return {
      id: request.id,
      ok: true,
      delta: {
        generationId: request.generationId,
        retainedBytes: replacement.catalog.retainedBytes,
        deltaPathCount: mutations.size + deletedPrefixes.size,
        deltaBytes: mutationBytes,
        compacted: true
      },
      events
    }
  } catch (error) {
    await spillRuns.cleanupScratch()
    if (replacementCatalog) {
      await removeWorkspacePathCatalogSpill(replacementCatalog).catch(() => undefined)
    }
    throw error
  }
}

class WorkspacePathSpillDeletePrefixIndex {
  private readonly prefixes: { path: string; sequence: number }[] = []

  get size(): number {
    return this.prefixes.length
  }

  add(path: string, sequence: number): void {
    const prefix = normalizeSpillPrefix(path)
    if (prefix) {
      this.prefixes.push({ path: prefix, sequence })
    }
  }

  latestSequence(path: string): number {
    let latestSequence = -1
    for (const prefix of this.prefixes) {
      if (
        (path === prefix.path || path.startsWith(`${prefix.path}/`)) &&
        prefix.sequence > latestSequence
      ) {
        latestSequence = prefix.sequence
      }
    }
    return latestSequence
  }
}

function normalizeSpillPrefix(path: string): string {
  return normalizeWorkspaceRelativePath(path).replace(/\/+$/, '')
}
