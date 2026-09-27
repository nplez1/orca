import { z } from 'zod'
import type {
  WorkspacePathSearchCountProvenance,
  WorkspacePathSearchFenceIdentity,
  WorkspacePathSearchResponse,
  WorkspacePathSearchRowClassificationFlags
} from './workspace-path-search-contract'

const WorkspacePathSearchFenceIdentitySchema = z.object({
  query: z.string(),
  consumer: z.object({ consumerId: z.string(), sequence: z.number().int().nonnegative() }),
  owner: z.object({
    executionHost: z.object({ provider: z.string(), incarnationId: z.string() }),
    authorizedCanonicalRoot: z.string()
  }),
  generationId: z.string().nullable(),
  mode: z.literal('name-filter'),
  scope: z.object({
    pathSet: z.enum(['included', 'all']),
    includeDotfiles: z.boolean(),
    includeIgnoredFiles: z.boolean(),
    excludePathSegments: z.array(z.array(z.string()))
  }),
  pageBudget: z.object({
    maxPaths: z.number().int().positive(),
    maxSerializedBytes: z.number().int().positive()
  })
})

const WireWorkspacePathSearchResponseSchema = z.object({
  requestIdentity: WorkspacePathSearchFenceIdentitySchema,
  generationId: z.string(),
  scopeFingerprint: z.string(),
  scopeRuleVersion: z.string(),
  rows: z.array(z.object({ relativePath: z.string() })),
  rowClassificationFlags: z.array(z.number().int()),
  retainedCount: z.number().int().nonnegative(),
  state: z.object({
    coverage: z.string(),
    freshness: z.string(),
    countProvenance: z.string(),
    searchComplete: z.boolean()
  }),
  count: z.object({ value: z.number().int().nonnegative().nullable(), provenance: z.string() }),
  degradationReason: z.string().optional()
})

export function parseWorkspacePathSearchWireResponse(
  value: unknown,
  expectedIdentity: WorkspacePathSearchFenceIdentity
): WorkspacePathSearchResponse {
  const parsed = WireWorkspacePathSearchResponseSchema.parse(value)
  if (
    !matchesExpectedFence(parsed.requestIdentity, expectedIdentity) ||
    parsed.scopeFingerprint !== JSON.stringify(parsed.requestIdentity.scope) ||
    parsed.retainedCount !== parsed.rows.length ||
    parsed.rowClassificationFlags.length !== parsed.rows.length
  ) {
    throw new Error('Workspace path search response does not match its request fence')
  }

  const common = {
    requestIdentity: parsed.requestIdentity,
    generationId: parsed.generationId,
    scopeFingerprint: parsed.scopeFingerprint,
    scopeRuleVersion: parsed.scopeRuleVersion,
    rows: parsed.rows,
    rowClassificationFlags: parsed.rowClassificationFlags.map(normalizeRowFlags),
    retainedCount: parsed.rows.length,
    ...(parsed.degradationReason === undefined
      ? {}
      : { degradationReason: parsed.degradationReason })
  }
  if (
    parsed.state.coverage === 'complete' &&
    parsed.state.freshness === 'no-known-gap' &&
    parsed.state.countProvenance === 'exact-snapshot' &&
    parsed.state.searchComplete &&
    parsed.count.provenance === 'exact-snapshot' &&
    parsed.count.value !== null
  ) {
    return {
      ...common,
      state: {
        coverage: 'complete',
        freshness: 'no-known-gap',
        countProvenance: 'exact-snapshot',
        searchComplete: true
      },
      count: { value: parsed.count.value, provenance: 'exact-snapshot' }
    }
  }

  const coverage = normalizeCoverage(parsed.state.coverage, parsed.state.searchComplete)
  const countProvenance = normalizeCountProvenance(
    parsed.state.countProvenance,
    parsed.count.provenance,
    parsed.state.freshness
  )
  const valueCount =
    countProvenance === 'legacy' && parsed.count.provenance === 'exact-snapshot'
      ? null
      : parsed.count.value
  if (coverage === 'complete') {
    return {
      ...common,
      state: {
        coverage: 'complete',
        freshness: parsed.state.freshness,
        countProvenance,
        searchComplete: true
      },
      count: { value: valueCount, provenance: countProvenance }
    }
  }
  return {
    ...common,
    state: {
      coverage,
      freshness: parsed.state.freshness,
      countProvenance,
      searchComplete: false
    },
    count: { value: valueCount, provenance: countProvenance }
  }
}

function matchesExpectedFence(
  actual: WorkspacePathSearchFenceIdentity,
  expected: WorkspacePathSearchFenceIdentity
): boolean {
  return (
    actual.query === expected.query &&
    actual.consumer.consumerId === expected.consumer.consumerId &&
    actual.consumer.sequence === expected.consumer.sequence &&
    actual.mode === expected.mode &&
    JSON.stringify(actual.scope) === JSON.stringify(expected.scope) &&
    actual.pageBudget.maxPaths <= expected.pageBudget.maxPaths &&
    actual.pageBudget.maxSerializedBytes <= expected.pageBudget.maxSerializedBytes
  )
}

function normalizeCoverage(
  coverage: string,
  searchComplete: boolean
): 'partial' | 'unavailable' | 'complete' {
  if (coverage === 'complete' && searchComplete) {
    return 'complete'
  }
  return coverage === 'unavailable' ? 'unavailable' : 'partial'
}

function normalizeCountProvenance(
  stateProvenance: string,
  countProvenance: string,
  freshness: string
): Exclude<WorkspacePathSearchCountProvenance, 'exact-snapshot'> {
  const candidate = stateProvenance === countProvenance ? stateProvenance : 'legacy'
  switch (candidate) {
    case 'provisional':
    case 'last-known':
    case 'sentinel':
    case 'legacy':
      return candidate
    case 'exact-snapshot':
      return freshness === 'provisional' ? 'provisional' : 'last-known'
    default:
      return 'legacy'
  }
}

function normalizeRowFlags(value: number): WorkspacePathSearchRowClassificationFlags {
  switch (value) {
    case 2:
    case 4:
    case 5:
    case 6:
    case 7:
      return value
    default:
      return 0
  }
}
