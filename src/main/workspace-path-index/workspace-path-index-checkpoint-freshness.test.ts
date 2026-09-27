import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  createCompleteWorkspacePathSearchResponse,
  createPartialWorkspacePathSearchResponse
} from '../../shared/workspace-path-search-response'
import type {
  WorkspacePathSearchFenceIdentity,
  WorkspacePathSearchOwnerIdentity,
  WorkspacePathSearchResponse
} from '../../shared/workspace-path-search-contract'
import { withWorkspacePathSearchFreshness } from './workspace-path-index-freshness'
import { WorkspacePathIndexAdmission } from './workspace-path-index-admission'
import { WorkspacePathIndexService } from './workspace-path-index-service'

const OWNER: WorkspacePathSearchOwnerIdentity = {
  executionHost: { provider: 'local', incarnationId: 'host-1' },
  authorizedCanonicalRoot: '/workspace/a'
}
const RESTORED_GENERATION = 'restored-generation'
const REBUILT_GENERATION = 'rebuilt-generation'

function boundedPartialResponse(
  requestIdentity: WorkspacePathSearchFenceIdentity
): WorkspacePathSearchResponse {
  return {
    requestIdentity,
    generationId: RESTORED_GENERATION,
    scopeFingerprint: JSON.stringify(requestIdentity.scope),
    scopeRuleVersion: 'quick-open-scope-v1',
    rows: [{ relativePath: 'src/early-match.ts' }],
    rowClassificationFlags: [0],
    retainedCount: 1,
    state: {
      coverage: 'partial',
      freshness: 'provisional',
      countProvenance: 'provisional',
      searchComplete: false
    },
    count: { value: null, provenance: 'provisional' },
    degradationReason: 'partial-page-bounded'
  }
}

function identity(sequence = 1): WorkspacePathSearchFenceIdentity {
  return {
    query: 'nothing-matches-this',
    consumer: { consumerId: 'window-1', sequence },
    owner: OWNER,
    generationId: null,
    mode: 'name-filter',
    scope: {
      pathSet: 'included',
      includeDotfiles: false,
      includeIgnoredFiles: false,
      excludePathSegments: []
    },
    pageBudget: { maxPaths: 10, maxSerializedBytes: 10_000 }
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((finish) => {
    resolve = finish
  })
  return { promise, resolve }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function buildService(args: {
  restoreCheckpoint?: (input: {
    owner: WorkspacePathSearchOwnerIdentity
    entryKey: string
  }) => Promise<{
    generationId: string
    publishedScope: 'included' | 'all' | 'both'
    retainedBytes: number
    loadMilliseconds: number
  } | null>
  build?: (request: { generationId: string }) => Promise<{
    generationId: string
    retainedBytes: number
  }>
  deleteCheckpoint?: (owner: WorkspacePathSearchOwnerIdentity) => void
  query?: (identity: WorkspacePathSearchFenceIdentity) => Promise<WorkspacePathSearchResponse>
  admission?: WorkspacePathIndexAdmission
  rootBudgetBytes?: number
}): WorkspacePathIndexService {
  return new WorkspacePathIndexService({
    authorize: async (owner) => owner.authorizedCanonicalRoot,
    build: async (request) =>
      args.build?.(request) ?? {
        generationId: request.generationId,
        retainedBytes: 512
      },
    query: async ({ identity: requestIdentity }) =>
      args.query?.(requestIdentity) ??
      createCompleteWorkspacePathSearchResponse({
        requestIdentity,
        paths: [],
        totalCount: 0,
        generationId: requestIdentity.generationId ?? RESTORED_GENERATION
      }),
    admission: args.admission ?? new WorkspacePathIndexAdmission(10_000, 40_000),
    peakBuildReservationBytes: args.rootBudgetBytes ?? 512,
    restoreCheckpoint: args.restoreCheckpoint,
    deleteCheckpoint: args.deleteCheckpoint
  })
}

function searchArgs(correlationId: string) {
  return {
    identity: identity(),
    listingPolicyVersion: 'listing-v1',
    foldVersion: 'fold-v1',
    buildReservationBytes: 512,
    correlationId
  }
}

describe('workspace path index checkpoint freshness contract', () => {
  it('serves last-known rows as provisional, then promotes to ready after reconciliation', async () => {
    const reconciliation = deferred()
    const restoreCheckpoint = vi.fn(async () => ({
      generationId: RESTORED_GENERATION,
      publishedScope: 'both' as const,
      retainedBytes: 1_000,
      loadMilliseconds: 5
    }))
    const build = vi.fn(async () => {
      await reconciliation.promise
      return { generationId: REBUILT_GENERATION, retainedBytes: 512 }
    })
    const service = buildService({ restoreCheckpoint, build })

    // The restored snapshot has no matches. Provisional last-known may show zero rows, but it must
    // never claim an exact snapshot count or a completed search — that is the "No files match" bar.
    const restored = await service.search(searchArgs('123e4567-e89b-42d3-a456-426614174001'))
    expect(restored.ready).toBe(true)
    if (!restored.ready) {
      return
    }
    expect(restored.response.state).toMatchObject({
      coverage: 'complete',
      freshness: 'provisional',
      countProvenance: 'last-known',
      searchComplete: true
    })
    expect(restored.response.count).toEqual({
      value: 0,
      provenance: 'last-known'
    })
    expect(restored.response.state.countProvenance).not.toBe('exact-snapshot')
    expect(restoreCheckpoint).toHaveBeenCalledTimes(1)
    expect(build).toHaveBeenCalledTimes(1)

    reconciliation.resolve()
    await settle()
    const promoted = await service.search(searchArgs('123e4567-e89b-42d3-a456-426614174002'))
    expect(promoted.ready).toBe(true)
    if (!promoted.ready) {
      return
    }
    expect(promoted.response.generationId).toBe(REBUILT_GENERATION)
    expect(promoted.response.state).toMatchObject({
      coverage: 'complete',
      freshness: 'no-known-gap',
      countProvenance: 'exact-snapshot',
      searchComplete: true
    })
    expect(promoted.response.count).toEqual({
      value: 0,
      provenance: 'exact-snapshot'
    })
    expect(build).toHaveBeenCalledTimes(1)
    service.dispose()
  })

  it('keeps a bounded provisional page partial through the service until reconciliation publishes', async () => {
    const reconciliation = deferred()
    const query = vi.fn(async (requestIdentity: WorkspacePathSearchFenceIdentity) =>
      requestIdentity.generationId === RESTORED_GENERATION
        ? boundedPartialResponse(requestIdentity)
        : createCompleteWorkspacePathSearchResponse({
            requestIdentity,
            paths: ['src/late-match.ts'],
            totalCount: 1,
            generationId: requestIdentity.generationId ?? REBUILT_GENERATION
          })
    )
    const service = buildService({
      restoreCheckpoint: async () => ({
        generationId: RESTORED_GENERATION,
        publishedScope: 'both' as const,
        retainedBytes: 1_000,
        loadMilliseconds: 5
      }),
      build: async () => {
        await reconciliation.promise
        return { generationId: REBUILT_GENERATION, retainedBytes: 512 }
      },
      query
    })

    const restored = await service.search(searchArgs('123e4567-e89b-42d3-a456-426614174007'))
    expect(restored.ready).toBe(true)
    if (!restored.ready) {
      return
    }
    // The bounded prefix may show last-known rows, but its coverage stays partial and its total stays
    // null: the service must never upgrade a bounded page into an exact snapshot answer.
    expect(restored.response.state).toEqual({
      coverage: 'partial',
      freshness: 'provisional',
      countProvenance: 'provisional',
      searchComplete: false
    })
    expect(restored.response.count).toEqual({
      value: null,
      provenance: 'provisional'
    })
    expect(restored.response.rows.map((row) => row.relativePath)).toEqual(['src/early-match.ts'])
    expect(restored.response.degradationReason).toBe('partial-page-bounded')

    reconciliation.resolve()
    await settle()
    const promoted = await service.search(searchArgs('123e4567-e89b-42d3-a456-426614174008'))
    expect(promoted.ready).toBe(true)
    if (!promoted.ready) {
      return
    }
    expect(promoted.response.generationId).toBe(REBUILT_GENERATION)
    expect(promoted.response.state).toEqual({
      coverage: 'complete',
      freshness: 'no-known-gap',
      countProvenance: 'exact-snapshot',
      searchComplete: true
    })
    expect(promoted.response.count).toEqual({
      value: 1,
      provenance: 'exact-snapshot'
    })
    service.dispose()
  })

  it('never authorizes a definitive count or empty state before reconciliation completes', async () => {
    const partial = createPartialWorkspacePathSearchResponse({
      requestIdentity: identity(),
      paths: [],
      generationId: RESTORED_GENERATION,
      degradationReason: 'building'
    })
    const provisionalPartial = withWorkspacePathSearchFreshness(partial, 'provisional')
    expect(provisionalPartial.state.searchComplete).toBe(false)
    expect(provisionalPartial.count).toEqual({
      value: null,
      provenance: 'provisional'
    })

    const complete = createCompleteWorkspacePathSearchResponse({
      requestIdentity: identity(),
      paths: [],
      totalCount: 0,
      generationId: RESTORED_GENERATION
    })
    const provisionalComplete = withWorkspacePathSearchFreshness(complete, 'provisional')
    expect(provisionalComplete.count.provenance).toBe('last-known')
    expect(provisionalComplete.state.countProvenance).not.toBe('exact-snapshot')

    // Only a complete, no-known-gap snapshot may carry the authoritative empty answer.
    const authoritative = withWorkspacePathSearchFreshness(complete, 'no-known-gap')
    expect(authoritative.state).toMatchObject({
      coverage: 'complete',
      freshness: 'no-known-gap',
      countProvenance: 'exact-snapshot'
    })
  })

  it('drops a restored generation rather than letting it block its own reconciliation', async () => {
    const query = vi.fn(async (requestIdentity: WorkspacePathSearchFenceIdentity) =>
      createCompleteWorkspacePathSearchResponse({
        requestIdentity,
        paths: [],
        totalCount: 0,
        generationId: requestIdentity.generationId ?? RESTORED_GENERATION
      })
    )
    const service = buildService({
      restoreCheckpoint: async () => ({
        generationId: RESTORED_GENERATION,
        publishedScope: 'both',
        retainedBytes: 1_000,
        loadMilliseconds: 5
      }),
      // Root budget fits the build, but the host cannot hold the restore plus the build peak.
      admission: new WorkspacePathIndexAdmission(10_000, 1_500),
      rootBudgetBytes: 1_000,
      query
    })
    const result = await service.search(searchArgs('123e4567-e89b-42d3-a456-426614174003'))
    expect(result).toEqual({ ready: false, reason: 'building' })
    expect(query).not.toHaveBeenCalled()
    service.dispose()
  })

  it('refuses a restore the host budget cannot account for', async () => {
    const query = vi.fn(async (requestIdentity: WorkspacePathSearchFenceIdentity) =>
      createCompleteWorkspacePathSearchResponse({
        requestIdentity,
        paths: [],
        totalCount: 0,
        generationId: requestIdentity.generationId ?? RESTORED_GENERATION
      })
    )
    const service = buildService({
      restoreCheckpoint: async () => ({
        generationId: RESTORED_GENERATION,
        publishedScope: 'both',
        retainedBytes: 9_000,
        loadMilliseconds: 5
      }),
      admission: new WorkspacePathIndexAdmission(10_000, 20_000),
      rootBudgetBytes: 512,
      query
    })
    const result = await service.search(searchArgs('123e4567-e89b-42d3-a456-426614174004'))
    expect(result.ready).toBe(true)
    if (!result.ready) {
      return
    }
    // The unaccounted restore was refused, so the answer comes from the reconciled generation.
    expect(result.response.generationId).not.toBe(RESTORED_GENERATION)
    service.dispose()
  })

  it('deletes a root checkpoint when its authorization is revoked', async () => {
    const deleteCheckpoint = vi.fn()
    const service = buildService({
      restoreCheckpoint: async () => null,
      deleteCheckpoint
    })
    await service.ensure({
      owner: OWNER,
      listingPolicyVersion: 'listing-v1',
      foldVersion: 'fold-v1',
      buildReservationBytes: 512,
      correlationId: '123e4567-e89b-42d3-a456-426614174005'
    })
    await settle()
    service.revoke(OWNER)
    expect(deleteCheckpoint).toHaveBeenCalledWith(OWNER)
    service.dispose()

    const unauthorized = vi.fn()
    const revokedService = new WorkspacePathIndexService({
      authorize: async () => null,
      build: async (request) => ({
        generationId: request.generationId,
        retainedBytes: 0
      }),
      query: async ({ identity: requestIdentity }) =>
        createCompleteWorkspacePathSearchResponse({
          requestIdentity,
          paths: [],
          totalCount: 0,
          generationId: 'unused'
        }),
      deleteCheckpoint: unauthorized
    })
    await revokedService.ensure({
      owner: OWNER,
      listingPolicyVersion: 'listing-v1',
      foldVersion: 'fold-v1',
      buildReservationBytes: 512,
      correlationId: '123e4567-e89b-42d3-a456-426614174006'
    })
    expect(unauthorized).toHaveBeenCalledWith(OWNER)
    revokedService.dispose()
  })
})

describe('checkpoint privacy boundary', () => {
  it('keeps checkpoint bytes out of every remote and renderer source tree', async () => {
    const forbidden = [
      'workspace-path-catalog-checkpoint',
      'WORKSPACE_PATH_CATALOG_CHECKPOINT',
      'restoreCheckpoint',
      'writeCheckpoint'
    ]
    const roots = ['src/relay', 'src/shared/rpc-contract', 'src/renderer', 'src/preload']
    const offenders: string[] = []
    for (const root of roots) {
      for (const file of await listTypeScriptFiles(join(process.cwd(), root))) {
        const source = await readFile(file, 'utf8')
        if (forbidden.some((needle) => source.includes(needle))) {
          offenders.push(relative(process.cwd(), file))
        }
      }
    }
    expect(offenders).toEqual([])
  })
})

async function listTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const files: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await listTypeScriptFiles(path)))
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      files.push(path)
    }
  }
  return files
}
