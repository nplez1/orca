import {
  assertWorkspacePathSearchEquivalent,
  runNameFilterPathMatcher,
  runWorkspacePathSearchOracle,
  type WorkspacePathSearchOracleOptions,
  type WorkspacePathSearchPage
} from './workspace-path-search-oracle'

export const WORKSPACE_PATH_SEARCH_QUERY_BATTERY = [
  { id: 'empty-query', query: '' },
  { id: 'whitespace-only', query: ' \t\n ' },
  { id: 'one-character', query: 'a' },
  { id: 'two-characters', query: 'ts' },
  { id: 'three-characters', query: 'tsx' },
  { id: 'and-tokens', query: 'components button' },
  { id: 'reordered-tokens', query: 'button components' },
  { id: 'repeated-tokens', query: 'components button components' },
  { id: 'trimmed-whitespace', query: '  Button \t components  ' },
  { id: 'extension-fragment', query: '.tsx' },
  { id: 'directory-fragment', query: 'components' },
  { id: 'slash-spanning-fragment', query: 'components/button' },
  { id: 'turkish-dotted-i', query: 'İstanbul' },
  { id: 'turkish-dotless-i', query: 'ısparta' },
  { id: 'combining-mark', query: 'cafe\u0301' },
  { id: 'supplementary-plane', query: '𐐨' },
  { id: 'mixed-case', query: 'bUtToN' },
  { id: 'natural-sort-tie', query: 'item-' },
  { id: 'no-match', query: 'certainly-no-path-has-this-token' },
  { id: 'cardinality-census', query: 'cardinality match' },
  { id: 'long-json-escaped-path', query: 'budget target' }
] as const

export type WorkspacePathSearchQueryCase = (typeof WORKSPACE_PATH_SEARCH_QUERY_BATTERY)[number]

export type WorkspacePathSearchQueryBatteryRow = {
  id: string
  query: string
  expected: WorkspacePathSearchPage
  actual: WorkspacePathSearchPage
}

export type WorkspacePathSearchCandidate = (
  snapshot: Iterable<string>,
  query: string,
  options?: WorkspacePathSearchOracleOptions
) => WorkspacePathSearchPage

/** Replays the same query cases against fresh deterministic snapshots for oracle and candidate. */
export function runWorkspacePathSearchQueryBattery(
  snapshotFactory: () => Iterable<string>,
  options: WorkspacePathSearchOracleOptions = {},
  candidate: WorkspacePathSearchCandidate = runNameFilterPathMatcher
): WorkspacePathSearchQueryBatteryRow[] {
  return WORKSPACE_PATH_SEARCH_QUERY_BATTERY.map(({ id, query }) => {
    const expected = runWorkspacePathSearchOracle(snapshotFactory(), query, options)
    const actual = candidate(snapshotFactory(), query, options)
    assertWorkspacePathSearchEquivalent(query, expected, actual)
    return { id, query, expected, actual }
  })
}

/** Synthetic-only paths exercise JSON string escaping; they are never materialized on disk. */
export function createLongJsonEscapedPathCatalog(): string[] {
  return [0, 1, 2].map(
    (index) => `src/long-budget/"quoted-segment-${index}-${'x'.repeat(72)}"-target.ts`
  )
}
