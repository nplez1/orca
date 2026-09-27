import { createHash } from 'node:crypto'
import {
  runWorkspacePathSearchOracle,
  type WorkspacePathSearchOracleOptions
} from './workspace-path-search-oracle'

export const WORKSPACE_PATH_SEARCH_SHADOW_SAMPLE_RATE_ENV =
  'ORCA_WORKSPACE_PATH_SEARCH_SHADOW_SAMPLE_RATE'
export const DEFAULT_WORKSPACE_PATH_SEARCH_SHADOW_SAMPLE_RATE = 0.01

export type WorkspacePathSearchShadowPage = {
  paths: readonly string[]
  totalCount: number
}

export type WorkspacePathSearchShadowMismatch = {
  fixtureIdHash: string
  queryHash: string
  differenceCount: number
  expectedTotalCount: number
  actualTotalCount: number
}

export type WorkspacePathSearchShadowResult = {
  sampled: boolean
  actual: WorkspacePathSearchShadowPage
  mismatch: WorkspacePathSearchShadowMismatch | null
}

export async function runWorkspacePathSearchShadowSample(args: {
  fixtureId: string
  query: string
  snapshot: readonly string[]
  oracleOptions?: WorkspacePathSearchOracleOptions
  actual: () => WorkspacePathSearchShadowPage | Promise<WorkspacePathSearchShadowPage>
  sampleRate?: number
  onMismatch?: (mismatch: WorkspacePathSearchShadowMismatch) => void
}): Promise<WorkspacePathSearchShadowResult> {
  const actual = await args.actual()
  const sampleRate = args.sampleRate ?? configuredSampleRate()
  if (!isWorkspacePathSearchShadowSampled(args.fixtureId, args.query, sampleRate)) {
    return { sampled: false, actual, mismatch: null }
  }

  const expected = runWorkspacePathSearchOracle(args.snapshot, args.query, args.oracleOptions)
  const differenceCount = countPageDifferences(expected, actual)
  if (differenceCount === 0) {
    return { sampled: true, actual, mismatch: null }
  }

  const mismatch: WorkspacePathSearchShadowMismatch = {
    fixtureIdHash: hashIdentifier(args.fixtureId),
    queryHash: hashIdentifier(args.query),
    differenceCount,
    expectedTotalCount: expected.totalCount,
    actualTotalCount: actual.totalCount
  }
  if (args.onMismatch) {
    args.onMismatch(mismatch)
  } else {
    process.emitWarning(`[workspace-path-search-shadow] ${JSON.stringify(mismatch)}`)
  }
  return { sampled: true, actual, mismatch }
}

export function isWorkspacePathSearchShadowSampled(
  fixtureId: string,
  query: string,
  sampleRate: number
): boolean {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    return false
  }
  if (sampleRate >= 1) {
    return true
  }
  const sampleId = createHash('sha256')
    .update(fixtureId)
    .update('\u0000')
    .update(query)
    .digest()
    .readUInt32BE(0)
  return sampleId / 0x1_0000_0000 < sampleRate
}

function configuredSampleRate(): number {
  const value = process.env[WORKSPACE_PATH_SEARCH_SHADOW_SAMPLE_RATE_ENV]
  if (value === undefined) {
    return DEFAULT_WORKSPACE_PATH_SEARCH_SHADOW_SAMPLE_RATE
  }
  const parsed = Number(value)
  return Number.isFinite(parsed)
    ? Math.max(0, Math.min(1, parsed))
    : DEFAULT_WORKSPACE_PATH_SEARCH_SHADOW_SAMPLE_RATE
}

function countPageDifferences(
  expected: { paths: readonly string[]; totalCount: number },
  actual: WorkspacePathSearchShadowPage
): number {
  let differenceCount = expected.totalCount === actual.totalCount ? 0 : 1
  if (expected.paths.length !== actual.paths.length) {
    differenceCount += 1
  }
  const sharedLength = Math.min(expected.paths.length, actual.paths.length)
  for (let index = 0; index < sharedLength; index += 1) {
    if (expected.paths[index] !== actual.paths[index]) {
      differenceCount += 1
    }
  }
  return differenceCount
}

function hashIdentifier(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}
