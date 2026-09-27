import { describe, expect, it, vi } from 'vitest'
import type {
  WorkspacePathSearchFenceIdentity,
  WorkspacePathSearchOwnerIdentity
} from '../../shared/workspace-path-search-contract'
import { createCompleteWorkspacePathSearchResponse } from '../../shared/workspace-path-search-response'
import {
  workspacePathIndexFreshnessDeadlineForOwner,
  workspacePathIndexValidationIntervalForOwner
} from './workspace-path-index-owner-cadence'
import { withWorkspacePathSearchFreshness } from './workspace-path-index-freshness'

// Why mocked: parseWslPath only detects WSL on win32, and this cadence must be asserted on any
// development host.
vi.mock('../wsl', () => ({
  parseWslPath: (windowsPath: string) =>
    windowsPath.startsWith('\\\\wsl') ? { distro: 'Ubuntu', linuxPath: '/home/dev/repo' } : null
}))

const WSL_ROOT = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo'
const LOCAL_ROOT = '/home/dev/repo'

function ownerForRoot(authorizedCanonicalRoot: string): WorkspacePathSearchOwnerIdentity {
  return {
    executionHost: { provider: 'local', incarnationId: 'owner-cadence-test' },
    authorizedCanonicalRoot
  }
}

function completeResponse(
  owner: WorkspacePathSearchOwnerIdentity
): ReturnType<typeof createCompleteWorkspacePathSearchResponse> {
  const identity: WorkspacePathSearchFenceIdentity = {
    query: 'item',
    consumer: { consumerId: 'owner-cadence', sequence: 1 },
    owner,
    generationId: 'generation-1',
    mode: 'name-filter',
    scope: {
      pathSet: 'all',
      includeDotfiles: true,
      includeIgnoredFiles: true,
      excludePathSegments: []
    },
    pageBudget: { maxPaths: 5_000, maxSerializedBytes: 100_000 }
  }
  return createCompleteWorkspacePathSearchResponse({
    requestIdentity: identity,
    paths: ['src/target.ts'],
    totalCount: 1,
    generationId: 'generation-1'
  })
}

describe('workspace-path-index owner cadence', () => {
  it('gives WSL roots the short validation interval and deadline', () => {
    // plan §5.3: the WSL watcher polls only two levels, so the declared 1 min / 2 min cadence is
    // what bounds deep-path staleness.
    const owner = ownerForRoot(WSL_ROOT)
    expect(workspacePathIndexValidationIntervalForOwner(owner)).toBe(60_000)
    expect(workspacePathIndexFreshnessDeadlineForOwner(owner)).toBe(2 * 60_000)
  })

  it('isolates local owners from the WSL cadence', () => {
    const owner = ownerForRoot(LOCAL_ROOT)
    expect(workspacePathIndexValidationIntervalForOwner(owner)).toBe(5 * 60_000)
    expect(workspacePathIndexFreshnessDeadlineForOwner(owner)).toBe(15 * 60_000)
  })

  it('keeps coverage complete when the committed freshness deadline lapses', () => {
    // A lapsed deadline downgrades freshness only: the rows still cover the whole snapshot, so
    // the count becomes a last-known value rather than the coverage silently shrinking.
    const lapsed = withWorkspacePathSearchFreshness(
      completeResponse(ownerForRoot(WSL_ROOT)),
      'dirty'
    )

    expect(lapsed.state).toMatchObject({
      coverage: 'complete',
      freshness: 'dirty',
      countProvenance: 'last-known',
      searchComplete: true
    })
    expect(lapsed.count).toEqual({ value: 1, provenance: 'last-known' })
  })
})
