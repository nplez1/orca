import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { compareFileNames } from '../../shared/file-name-sort'
import {
  resolveWorkspacePathFoldLocale,
  type WorkspacePathCatalog,
  type WorkspacePathCatalogMetadata
} from '../../shared/workspace-path-catalog'
import { queryWorkspacePathCatalog } from '../../shared/workspace-path-catalog-query'
import type { WorkspacePathSearchFenceIdentity } from '../../shared/workspace-path-search-contract'
import type {
  WorkspacePathSearchInstrumentationEvent,
  WorkspacePathSearchQueryMetrics
} from '../../shared/workspace-path-search-instrumentation'
import {
  WORKSPACE_PATH_PROVISIONAL_PAGE_MAX_ENCODED_BYTES,
  workspacePathProvisionalPageBudgetExhausted,
  type WorkspacePathProvisionalPageBudget
} from '../../shared/workspace-path-provisional-page-budget'
import {
  openWorkspacePathCatalogSpillReader,
  writeWorkspacePathCatalogSpill,
  type WorkspacePathSpillRecord
} from './workspace-path-catalog-spill'

const FOLD_VERSION = 'locale-lowercase-v1'
const SCOPE_RULE_VERSION = 'quick-open-scope-v1'
const OWNERSHIP_KEY = 'local::bounded-page-root'
const UNBOUNDED_BUDGET: WorkspacePathProvisionalPageBudget = {
  maxBlocks: 1_000_000,
  maxEncodedBytes: Number.POSITIVE_INFINITY,
  maxMilliseconds: 3_600_000
}

type SpilledCatalog = Extract<WorkspacePathCatalog, { storageKind: 'disk-spilled' }>

let temporaryDirectory: string | null = null

afterEach(async () => {
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
  temporaryDirectory = null
})

describe('bounded provisional page for a restored spilled catalog', () => {
  it('answers a bounded prefix as partial and never claims an exact or empty total', async () => {
    const catalog = await spilledCatalog(600)
    const bounded = await query(catalog, fenceIdentity('item', 4), {
      budget: { ...UNBOUNDED_BUDGET, maxBlocks: 1 }
    })
    expect(bounded.response.state).toEqual({
      coverage: 'partial',
      freshness: 'provisional',
      countProvenance: 'provisional',
      searchComplete: false
    })
    expect(bounded.response.count).toEqual({ value: null, provenance: 'provisional' })
    expect(bounded.response.degradationReason).toBe('partial-page-bounded')
    expect(bounded.response.state.countProvenance).not.toBe('exact-snapshot')
    // The budget is a block ceiling, and the page stopped at the block boundary.
    expect(bounded.blockReads).toBe(1)
    expect(bounded.metrics?.spillBlocksRead).toBe(1)
    expect(bounded.metrics?.scanComplete).toBe(false)

    // A query that matches nothing inside the prefix must still carry no total at all: a null count
    // is not 0, so the renderer can never promote it to "No files match".
    const noPrefixMatch = await query(catalog, fenceIdentity('zzz-absent', 4), {
      budget: { ...UNBOUNDED_BUDGET, maxBlocks: 1 }
    })
    expect(noPrefixMatch.response.rows).toEqual([])
    expect(noPrefixMatch.response.count).toEqual({ value: null, provenance: 'provisional' })
    expect(noPrefixMatch.response.state.searchComplete).toBe(false)

    // The same generation with no provisional budget is the promoted answer: an exact total.
    const exact = await query(catalog, fenceIdentity('item', 4))
    expect(exact.response.state).toEqual({
      coverage: 'complete',
      freshness: 'no-known-gap',
      countProvenance: 'exact-snapshot',
      searchComplete: true
    })
    expect(exact.response.count).toEqual({ value: 600, provenance: 'exact-snapshot' })
    // The bounded page is a real prefix of the exact page, so no re-sort is ever needed.
    expect(exact.response.rows.slice(0, 4)).toEqual(bounded.response.rows)
  })

  it('respects the block, byte, and time ceilings on a many-block catalog', async () => {
    const catalog = await spilledCatalog(4_096)
    // A token that matches nothing inside the prefix keeps the page from filling, so only the budget
    // can end the scan — the same reason a selective restart query is the expensive one.
    const identity = fenceIdentity('zzz-absent', 4)

    const byBlocks = await query(catalog, identity, {
      budget: {
        maxBlocks: 3,
        maxEncodedBytes: Number.POSITIVE_INFINITY,
        maxMilliseconds: 3_600_000
      }
    })
    expect(byBlocks.blockReads).toBe(3)
    expect(byBlocks.blockReads).toBeLessThan(catalog.spillBlockCount)
    expect(byBlocks.response.state.searchComplete).toBe(false)

    const byBytes = await query(catalog, identity, {
      budget: { maxBlocks: 1_000_000, maxEncodedBytes: 1, maxMilliseconds: 3_600_000 }
    })
    expect(byBytes.blockReads).toBe(1)
    expect(byBytes.metrics?.spillBytesRead).toBe(byBytes.firstBlockBytes)

    // One byte over the first block's encoded size lets exactly one more block through, so the byte
    // ceiling — not the block ceiling — is what stops this scan.
    const byBytesOneMore = await query(catalog, identity, {
      budget: {
        maxBlocks: 1_000_000,
        maxEncodedBytes: byBytes.firstBlockBytes + 1,
        maxMilliseconds: 3_600_000
      }
    })
    expect(byBytesOneMore.blockReads).toBe(2)

    const byTime = await query(catalog, identity, {
      budget: {
        maxBlocks: 1_000_000,
        maxEncodedBytes: Number.POSITIVE_INFINITY,
        maxMilliseconds: 0
      }
    })
    expect(byTime.blockReads).toBe(1)

    // Coverage is only claimed complete when the whole block range was actually read. Here the
    // complete answer is a legitimate exact zero, unlike the partial page's null count.
    const complete = await query(catalog, identity, { budget: UNBOUNDED_BUDGET })
    expect(complete.blockReads).toBe(catalog.spillBlockCount)
    expect(complete.metrics?.scanComplete).toBe(true)
    expect(complete.response.state).toEqual({
      coverage: 'complete',
      freshness: 'no-known-gap',
      countProvenance: 'exact-snapshot',
      searchComplete: true
    })
    expect(complete.response.count).toEqual({ value: 0, provenance: 'exact-snapshot' })
  })

  it('stops a huge spilled catalog far short of its end when the budget is spent', async () => {
    const catalog = await spilledCatalog(120_000)
    expect(catalog.spillBlockCount).toBeGreaterThan(400)
    const identity = fenceIdentity('zzz-absent', 4)

    const byBlocks = await query(catalog, identity, {
      budget: {
        maxBlocks: 64,
        maxEncodedBytes: WORKSPACE_PATH_PROVISIONAL_PAGE_MAX_ENCODED_BYTES,
        maxMilliseconds: 3_600_000
      }
    })
    expect(byBlocks.blockReads).toBe(64)
    expect(byBlocks.response.state).toEqual({
      coverage: 'partial',
      freshness: 'provisional',
      countProvenance: 'provisional',
      searchComplete: false
    })
    expect(byBlocks.response.count.value).toBeNull()

    // A wall-clock budget stops it earlier still, and never at the end of a 469-block catalog. 5 ms is
    // far below the ~50 ms this catalog needs to decode end to end even in-process.
    const byTime = await query(catalog, identity, {
      budget: {
        maxBlocks: 1_000_000,
        maxEncodedBytes: Number.POSITIVE_INFINITY,
        maxMilliseconds: 5
      }
    })
    expect(byTime.blockReads).toBeGreaterThan(0)
    expect(byTime.blockReads).toBeLessThan(catalog.spillBlockCount)
    expect(byTime.blockReads).toBeLessThan(468)
    expect(byTime.response.state.searchComplete).toBe(false)
  })

  it('bounds the exhausted-prefix predicate at each ceiling independently', () => {
    const budget: WorkspacePathProvisionalPageBudget = {
      maxBlocks: 4,
      maxEncodedBytes: 1_024,
      maxMilliseconds: 50
    }
    const notExhausted = { blocksRead: 3, encodedBytesRead: 1_023, startedAt: performance.now() }
    expect(workspacePathProvisionalPageBudgetExhausted({ ...notExhausted, budget })).toBe(false)
    expect(
      workspacePathProvisionalPageBudgetExhausted({ ...notExhausted, blocksRead: 4, budget })
    ).toBe(true)
    expect(
      workspacePathProvisionalPageBudgetExhausted({
        ...notExhausted,
        encodedBytesRead: 1_024,
        budget
      })
    ).toBe(true)
    expect(
      workspacePathProvisionalPageBudgetExhausted({
        blocksRead: 0,
        encodedBytesRead: 0,
        startedAt: performance.now() - 200,
        budget
      })
    ).toBe(true)
  })
})

async function query(
  catalog: SpilledCatalog,
  identity: WorkspacePathSearchFenceIdentity,
  options: { budget?: WorkspacePathProvisionalPageBudget } = {}
): Promise<{
  response: Awaited<ReturnType<typeof queryWorkspacePathCatalog>>
  blockReads: number
  firstBlockBytes: number
  metrics: WorkspacePathSearchQueryMetrics | undefined
}> {
  const reader = await openWorkspacePathCatalogSpillReader(catalog)
  const events: WorkspacePathSearchInstrumentationEvent[] = []
  let blockReads = 0
  let firstBlockBytes = 0
  try {
    const response = await queryWorkspacePathCatalog(catalog, {
      identity,
      onInstrumentation: (event) => events.push(event),
      ...(options.budget ? { provisionalPageBudget: options.budget } : {}),
      readSpilledBlock: async (blockIndex) => {
        blockReads += 1
        const block = await reader.readBlock(blockIndex)
        if (blockIndex === 0) {
          firstBlockBytes = block.encodedByteLength
        }
        return block
      }
    })
    let metrics: WorkspacePathSearchQueryMetrics | undefined
    for (const event of events) {
      if (event.kind === 'query-metrics') {
        metrics = event.record
      }
    }
    return { response, blockReads, firstBlockBytes, metrics }
  } finally {
    await reader.close()
  }
}

async function spilledCatalog(pathCount: number): Promise<SpilledCatalog> {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'orca-bounded-page-'))
  const source: WorkspacePathSpillRecord[] = []
  for (let index = 0; index < pathCount; index += 1) {
    source.push({
      relativePath: `src/group-${String(index % 32)}/item-${String(index)}.ts`,
      flags: 3
    })
  }
  source.sort((left, right) => compareFileNames(left.relativePath, right.relativePath))
  const written = await writeWorkspacePathCatalogSpill({
    directory: join(temporaryDirectory, 'spill'),
    identityKey: OWNERSHIP_KEY,
    generationId: 'bounded-page-generation',
    metadata: metadata(),
    pathCount: source.length,
    records: {
      async *[Symbol.asyncIterator]() {
        for (const record of source) {
          yield record
        }
      }
    }
  })
  if (written.catalog.storageKind !== 'disk-spilled') {
    throw new Error('Expected a disk-spilled catalog')
  }
  return written.catalog
}

function fenceIdentity(query: string, maxPaths: number): WorkspacePathSearchFenceIdentity {
  return {
    query,
    consumer: { consumerId: 'bounded-page-test', sequence: 1 },
    owner: {
      executionHost: { provider: 'local', incarnationId: 'bounded-page-test' },
      authorizedCanonicalRoot: '/fixture'
    },
    generationId: null,
    mode: 'name-filter',
    scope: {
      pathSet: 'all',
      includeDotfiles: true,
      includeIgnoredFiles: true,
      excludePathSegments: []
    },
    pageBudget: { maxPaths, maxSerializedBytes: Number.POSITIVE_INFINITY }
  }
}

function metadata(): WorkspacePathCatalogMetadata {
  return {
    foldLocale: resolveWorkspacePathFoldLocale(),
    foldVersion: FOLD_VERSION,
    scopeRuleVersion: SCOPE_RULE_VERSION,
    includedComplete: true,
    allComplete: true,
    classificationComplete: true,
    coverageExcludePathSegments: [],
    freshness: 'no-known-gap'
  }
}
