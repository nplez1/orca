import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  generateWorkspacePathCatalog,
  type WorkspacePathCatalogProfile
} from '../../shared/__fixtures__/workspace-path-catalog'
import {
  runWorkspacePathSearchOracle,
  assertWorkspacePathSearchEquivalent
} from '../../shared/__fixtures__/workspace-path-search-oracle'
import { WORKSPACE_PATH_SEARCH_QUERY_BATTERY } from '../../shared/__fixtures__/workspace-path-search-query-battery'
import { isEligibleWorkspaceCatalogPath } from '../../shared/workspace-path-catalog'
import { queryWorkspacePathCatalog } from '../../shared/workspace-path-catalog-query'
import type {
  WorkspacePathSearchFenceIdentity,
  WorkspacePathSearchScopeDescriptor
} from '../../shared/workspace-path-search-contract'
import { openWorkspacePathCatalogSpillReader } from './workspace-path-catalog-spill'
import { WorkspacePathCatalogSpillRuns } from './workspace-path-catalog-spill-runs'

const RUN_SPILLED_SCALE = process.env.ORCA_RUN_PATH_SEARCH_SCALE === '1'
const SPILLED_SCALE_SIZE = 1_000_000
// Oracle and query must share one budget: adversarial paths exceed 1 MB before 5,000 rows.
const SPILLED_SCALE_PAGE_BUDGET = {
  maxPaths: 5_000,
  maxSerializedBytes: 1_000_000
}
const SPILLED_SCALE_PROFILES: readonly WorkspacePathCatalogProfile[] = [
  'realistic-shared-prefixes',
  'adversarial-long-unshared'
]

let temporaryDirectory: string | null = null

afterEach(async () => {
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
  temporaryDirectory = null
})

describe.skipIf(!RUN_SPILLED_SCALE)('spilled workspace path scale parity', () => {
  it.each(SPILLED_SCALE_PROFILES)(
    'matches the full oracle battery and scope matrix for a spilled 1M %s catalog',
    async (profile) => {
      temporaryDirectory = await mkdtemp(join(tmpdir(), 'orca-spilled-scale-'))
      // The oracle is pure in (snapshot, query, scope): materialize the deterministic fixture once
      // instead of regenerating 1.35M paths for every scope x query.
      let fixtureSnapshot: string[] | null = null
      const paths = (): string[] => (fixtureSnapshot ??= [...exactFixturePaths(profile)])
      const runs = new WorkspacePathCatalogSpillRuns(
        temporaryDirectory,
        `spill-scale-${profile}`,
        `spill-scale-generation-${profile}`
      )
      for (const pathSet of ['included', 'all'] as const) {
        let batch: string[] = []
        for (const path of exactFixturePaths(profile)) {
          batch.push(path)
          if (batch.length === 256) {
            if (!(await runs.addBatch(pathSet, batch))) {
              throw new Error('Spilled scale build exceeded its bounded disk budget')
            }
            batch = []
          }
        }
        if (batch.length > 0 && !(await runs.addBatch(pathSet, batch))) {
          throw new Error('Spilled scale build exceeded its bounded disk budget')
        }
      }
      const first = await runs.finishFirstScope('included')
      expect(first?.catalog.storageKind).toBe('disk-spilled')
      const complete = await runs.finishAllScopes('all', `spill-scale-complete-${profile}`)
      expect(complete?.catalog.storageKind).toBe('disk-spilled')
      if (!complete || complete.catalog.storageKind !== 'disk-spilled') {
        throw new Error('Spilled scale catalog was not published')
      }
      // The oracle is pure in (snapshot, query, scope) and the path set never reaches it, so the
      // two scope path sets collapse to one computed expectation.
      const oracleCache = new Map<string, ReturnType<typeof runWorkspacePathSearchOracle>>()
      for (const scope of spilledScaleScopes()) {
        for (const queryCase of WORKSPACE_PATH_SEARCH_QUERY_BATTERY) {
          const oracleKey = [
            queryCase.query,
            scope.includeDotfiles,
            scope.includeIgnoredFiles,
            scope.excludePathSegments.map((segments) => segments.join('/')).join(',')
          ].join('\u0000')
          let expected = oracleCache.get(oracleKey)
          if (!expected) {
            expected = runWorkspacePathSearchOracle(paths(), queryCase.query, {
              scope: {
                rootPath: '/fixture',
                excludePaths: scope.excludePathSegments.map(
                  (segments) => `/fixture/${segments.join('/')}`
                ),
                ignoredPaths: new Set<string>(),
                includeDotfiles: scope.includeDotfiles,
                includeIgnoredFiles: scope.includeIgnoredFiles
              },
              pageBudget: SPILLED_SCALE_PAGE_BUDGET
            })
            oracleCache.set(oracleKey, expected)
          }
          const reader = await openWorkspacePathCatalogSpillReader(complete.catalog)
          try {
            const actual = await queryWorkspacePathCatalog(complete.catalog, {
              identity: spilledScaleIdentity(queryCase.query, scope),
              readSpilledBlock: reader.readBlock
            })
            assertWorkspacePathSearchEquivalent(queryCase.query, expected, {
              paths: actual.rows.map((row) => row.relativePath),
              totalCount: actual.count.value ?? -1
            })
          } finally {
            await reader.close()
          }
        }
      }
      console.info(
        `[spilled-path-search-scale] profile=${profile} count=${complete.catalog.pathCount}`
      )
      await runs.cleanupScratch()
    },
    // Opt-in 1M scale: ~336 exact spilled scans per profile dominate runtime; measured ~26 min total.
    7_200_000
  )
})

function* exactFixturePaths(profile: WorkspacePathCatalogProfile): Generator<string> {
  let includedCount = 0
  for (const path of generateWorkspacePathCatalog({
    size: Math.ceil(SPILLED_SCALE_SIZE * 1.35),
    profile,
    seed: 0x50455246
  })) {
    if (!isEligibleWorkspaceCatalogPath(path)) {
      continue
    }
    yield path
    includedCount += 1
    if (includedCount === SPILLED_SCALE_SIZE) {
      return
    }
  }
  throw new Error('Scale fixture did not contain one million eligible paths')
}

function spilledScaleScopes(): WorkspacePathSearchScopeDescriptor[] {
  const scopes: WorkspacePathSearchScopeDescriptor[] = []
  for (const pathSet of ['included', 'all'] as const) {
    for (const includeDotfiles of [false, true]) {
      for (const includeIgnoredFiles of [false, true]) {
        for (const includeExcludes of [false, true]) {
          scopes.push({
            pathSet,
            includeDotfiles,
            includeIgnoredFiles,
            excludePathSegments: includeExcludes ? [['packages', 'app']] : []
          })
        }
      }
    }
  }
  return scopes
}

function spilledScaleIdentity(
  query: string,
  scope: WorkspacePathSearchScopeDescriptor
): WorkspacePathSearchFenceIdentity {
  return {
    query,
    consumer: { consumerId: 'spilled-scale', sequence: 1 },
    owner: {
      executionHost: { provider: 'local', incarnationId: 'spilled-scale-host' },
      authorizedCanonicalRoot: '/fixture'
    },
    generationId: null,
    mode: 'name-filter',
    scope,
    pageBudget: SPILLED_SCALE_PAGE_BUDGET
  }
}
