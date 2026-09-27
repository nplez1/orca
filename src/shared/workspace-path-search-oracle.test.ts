import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { compareFileNames } from './file-name-sort'
import type { WorkspacePathSearchInstrumentationEvent } from './workspace-path-search-instrumentation'
import {
  generatePathMatchCardinalityCatalog,
  generateWorkspacePathCatalog
} from './__fixtures__/workspace-path-catalog'
import {
  createLongJsonEscapedPathCatalog,
  runWorkspacePathSearchQueryBattery,
  WORKSPACE_PATH_SEARCH_QUERY_BATTERY
} from './__fixtures__/workspace-path-search-query-battery'
import {
  assertWorkspacePathSearchEquivalent,
  findWorkspacePathSearchDifferences,
  runNameFilterPathMatcher,
  runWorkspacePathSearchOracle
} from './__fixtures__/workspace-path-search-oracle'

describe('workspace path-search correctness oracle', () => {
  it('agrees with NameFilterPathMatcher over the query battery and both generator profiles', () => {
    for (const profile of ['realistic-shared-prefixes', 'adversarial-long-unshared'] as const) {
      const rows = runWorkspacePathSearchQueryBattery(() =>
        generateWorkspacePathCatalog({ size: 512, profile, seed: 0x1234 })
      )
      expect(rows).toHaveLength(WORKSPACE_PATH_SEARCH_QUERY_BATTERY.length)
    }
  })

  it.each([0, 1, 5_000, 5_001, 20_002])(
    'matches exact totals and sorted retained pages for %i matching paths',
    (matchCount) => {
      const createSnapshot = () => generatePathMatchCardinalityCatalog(matchCount)
      const expected = runWorkspacePathSearchOracle(createSnapshot(), 'cardinality match')
      const actual = runNameFilterPathMatcher(createSnapshot(), 'cardinality match')

      assertWorkspacePathSearchEquivalent('cardinality match', expected, actual)
      expect(expected.totalCount).toBe(matchCount)
      expect(expected.paths).toHaveLength(Math.min(matchCount, 5_000))
      if (matchCount > 0) {
        expect(expected.paths).toEqual([...expected.paths].sort(compareFileNames))
      }
    },
    30_000
  )

  it('applies excluded-worktree, dotfile-ancestry, and ignored visibility before counting', () => {
    const snapshot = [
      'src/target-visible.ts',
      '.env/target-settings.json',
      'src/.generated/target-output.ts',
      'ignored/reports/target-ignored.ts',
      'packages/app/src/excluded-target.ts',
      'packages/app2/src/boundary-target.ts',
      'node_modules/@types/target/index.d.ts'
    ]
    const commonScope = {
      rootPath: '/workspace',
      excludePaths: ['/workspace/packages/app'],
      ignoredPaths: new Set(['ignored/reports/target-ignored.ts'])
    }

    const fullyVisible = runWorkspacePathSearchOracle(snapshot, 'target', {
      scope: { ...commonScope, includeDotfiles: true, includeIgnoredFiles: true }
    })
    expect(fullyVisible.paths).toEqual([
      '.env/target-settings.json',
      'ignored/reports/target-ignored.ts',
      'packages/app2/src/boundary-target.ts',
      'src/.generated/target-output.ts',
      'src/target-visible.ts'
    ])
    expect(fullyVisible.totalCount).toBe(5)

    const restricted = runWorkspacePathSearchOracle(snapshot, 'target', {
      scope: { ...commonScope, includeDotfiles: false, includeIgnoredFiles: false }
    })
    expect(restricted.paths).toEqual([
      'packages/app2/src/boundary-target.ts',
      'src/target-visible.ts'
    ])
    expect(restricted.totalCount).toBe(2)
  })

  it('keeps a sorted prefix when JSON-escaped long paths exhaust the byte budget', () => {
    const snapshot = createLongJsonEscapedPathCatalog()
    const sorted = [...snapshot].sort(compareFileNames)
    const firstPathBytes = Buffer.byteLength(JSON.stringify(sorted[0]!), 'utf8')
    const emptyPageBytes = Buffer.byteLength(JSON.stringify({ paths: [], totalCount: 3 }), 'utf8')
    const byteBudget = firstPathBytes + emptyPageBytes

    expect(firstPathBytes).toBeGreaterThan(Buffer.byteLength(sorted[0]!, 'utf8'))
    const result = runWorkspacePathSearchOracle(snapshot, 'budget target', {
      pageBudget: { maxPaths: 5_000, maxSerializedBytes: byteBudget }
    })
    expect(result.paths).toEqual([sorted[0]])
    expect(result.totalCount).toBe(3)
    expect(result.serializedPageBytes).toBe(byteBudget)
  })

  it('returns no results for empty or oversized input like the current matcher', () => {
    const snapshot = ['src/target.ts']
    for (const query of ['', ' \t ', 'x'.repeat(2_049)]) {
      const expected = runWorkspacePathSearchOracle(snapshot, query)
      const actual = runNameFilterPathMatcher(snapshot, query)
      assertWorkspacePathSearchEquivalent(query, expected, actual)
      expect(expected).toEqual({
        paths: [],
        totalCount: 0,
        serializedPageBytes: Buffer.byteLength(JSON.stringify({ paths: [], totalCount: 0 }), 'utf8')
      })
    }
  })

  it('emits the frozen host timing and query metrics without logging query text', () => {
    const events: WorkspacePathSearchInstrumentationEvent[] = []
    runWorkspacePathSearchOracle(
      [
        'src/target-sensitive-query.ts',
        'node_modules/package/target-sensitive-query.ts',
        'src/other.ts'
      ],
      'target-sensitive-query',
      {
        correlationId: 'fixture:oracle-test',
        generationId: 'fixture-generation-1',
        onInstrumentation: (event) => events.push(event)
      }
    )

    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({
      kind: 'stage-timing',
      record: {
        correlationId: 'fixture:oracle-test',
        stage: 'query-strategy',
        duration: { clock: 'execution-host-monotonic' }
      }
    })
    expect(events[1]).toEqual({
      kind: 'query-metrics',
      record: {
        correlationId: 'fixture:oracle-test',
        generationId: 'fixture-generation-1',
        strategy: 'ordered-scan',
        pathsConsidered: 3,
        candidates: 2,
        verifications: 2,
        exactMatches: 1,
        retained: 1,
        serializedBytes: Buffer.byteLength(
          JSON.stringify({ paths: ['src/target-sensitive-query.ts'], totalCount: 1 }),
          'utf8'
        )
      }
    })
    expect(JSON.stringify(events)).not.toContain('target-sensitive-query')
  })

  it('reports exact page positions and count in equivalence diagnostics', () => {
    const expected = { paths: ['src/a.ts', 'src/b.ts'], totalCount: 3 }
    const actual = { paths: ['src/a.ts', 'src/c.ts'], totalCount: 2 }
    expect(findWorkspacePathSearchDifferences(expected, actual)).toEqual([
      'totalCount: expected 3, received 2',
      'page[1]: expected "src/b.ts", received "src/c.ts"'
    ])
    expect(() => assertWorkspacePathSearchEquivalent('target', expected, actual)).toThrow(
      'Workspace path-search mismatch for "target"'
    )
  })
})
