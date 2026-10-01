import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GithubApiRepositoryModule from './github-api-repository'
import type * as GitHubEnterpriseRepositoryModule from './github-enterprise-repository'

const { clientMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('./client-test-mocks')
  return { clientMocks: moduleMocks.createGitHubClientMocks(), moduleMocks }
})

vi.mock('./gh-utils', () => moduleMocks.ghUtilsModuleMock(clientMocks))
vi.mock('../git/runner', () => moduleMocks.gitRunnerModuleMock(clientMocks))
vi.mock('../providers/ssh-git-dispatch', () => moduleMocks.sshGitDispatchModuleMock(clientMocks))
vi.mock('./local-git-config-signature', () =>
  moduleMocks.localGitConfigSignatureModuleMock(clientMocks)
)
vi.mock('./github-enterprise-repository', async (importOriginal) =>
  moduleMocks.githubEnterpriseRepositoryModuleMock(
    await importOriginal<typeof GitHubEnterpriseRepositoryModule>()
  )
)
vi.mock('./rate-limit', () => moduleMocks.rateLimitModuleMock(clientMocks))
vi.mock('./github-api-repository', async (importOriginal) =>
  moduleMocks.githubApiRepositoryModuleMock(
    clientMocks,
    await importOriginal<typeof GithubApiRepositoryModule>()
  )
)

import { mergePR } from './client'
import { resetGraphQLRateLimitGuardMocks } from './client-test-harness'
import { viewerMergePrivilegeCache } from './client/lookup/pr-viewer-merge-privilege'

const { ghExecFileAsyncMock } = clientMocks

const REPOSITORY = { owner: 'stablyai', repo: 'orca', host: 'github.com' }

/**
 * A merge on an approval-gated pull request, where the only question is whether the viewer's own
 * privilege to waive the rule is honoured — and only ever on the caller's say-so.
 */
function mockPRRequiringApproval(args: {
  number: number
  baseRefName: string | undefined
  viewerCanMergeAsAdmin: boolean | 'unanswered'
  mergeStateStatus?: string
}): void {
  const prView = {
    number: args.number,
    title: 'PR',
    state: 'OPEN',
    url: `https://github.com/stablyai/orca/pull/${String(args.number)}`,
    statusCheckRollup: [],
    updatedAt: '2026-04-01T00:00:00Z',
    isDraft: false,
    mergeable: 'MERGEABLE',
    reviewDecision: 'REVIEW_REQUIRED',
    // GitHub reports the merge box as open for a viewer who may bypass the review gate.
    mergeStateStatus: args.mergeStateStatus ?? 'UNSTABLE',
    autoMergeRequest: null,
    ...(args.baseRefName === undefined ? {} : { baseRefName: args.baseRefName }),
    baseRefOid: 'base-oid',
    headRefOid: 'head-oid'
  }
  ghExecFileAsyncMock
    .mockResolvedValueOnce({ stdout: JSON.stringify({ stack: null }) })
    .mockResolvedValueOnce({ stdout: JSON.stringify(prView) })
    // Repository merge metadata, then the viewer-scoped bypass probe.
    .mockResolvedValueOnce({ stdout: JSON.stringify({ data: { repository: {} } }) })
    .mockResolvedValueOnce({
      stdout: JSON.stringify(
        args.viewerCanMergeAsAdmin === 'unanswered'
          ? { data: { repository: { pullRequest: {} } } }
          : {
              data: {
                repository: {
                  pullRequest: { viewerCanMergeAsAdmin: args.viewerCanMergeAsAdmin }
                }
              }
            }
      )
    })
    .mockResolvedValue({ stdout: '', stderr: '' })
}

function mergeArgs(): string[] | undefined {
  const call = ghExecFileAsyncMock.mock.calls.find(
    (entry) => Array.isArray(entry[0]) && entry[0].includes('merge')
  )
  return call?.[0]
}

describe('GitHub admin merge bypass', () => {
  beforeEach(() => {
    resetGraphQLRateLimitGuardMocks(clientMocks)
    viewerMergePrivilegeCache.clear()
  })

  afterEach(() => vi.restoreAllMocks())

  it('merges with admin privileges when the caller confirmed the bypass', async () => {
    mockPRRequiringApproval({
      number: 41,
      baseRefName: 'bypass-granted',
      viewerCanMergeAsAdmin: true
    })

    await expect(
      mergePR(
        '/repo-root',
        41,
        'squash',
        undefined,
        REPOSITORY,
        {},
        {
          bypassBranchProtection: true
        }
      )
    ).resolves.toEqual({ ok: true })
    expect(mergeArgs()).toContain('--admin')
  })

  it('asks GitHub whether the viewer may bypass rather than assuming a review gate blocks', async () => {
    mockPRRequiringApproval({
      number: 42,
      baseRefName: 'bypass-probe',
      viewerCanMergeAsAdmin: true
    })

    await mergePR(
      '/repo-root',
      42,
      'squash',
      undefined,
      REPOSITORY,
      {},
      {
        bypassBranchProtection: true
      }
    )

    const probe = ghExecFileAsyncMock.mock.calls.find(
      (entry) =>
        Array.isArray(entry[0]) &&
        entry[0].some(
          (arg) =>
            typeof arg === 'string' &&
            arg.startsWith('query=') &&
            arg.includes('viewerCanMergeAsAdmin')
        )
    )
    expect(probe?.[0]).toEqual(
      expect.arrayContaining(['api', 'graphql', '-f', 'owner=stablyai', '-f', 'repo=orca'])
    )
  })

  it('still blocks when GitHub says this viewer cannot bypass', async () => {
    mockPRRequiringApproval({
      number: 43,
      baseRefName: 'bypass-denied',
      viewerCanMergeAsAdmin: false
    })

    await expect(
      mergePR(
        '/repo-root',
        43,
        'squash',
        undefined,
        REPOSITORY,
        {},
        {
          bypassBranchProtection: true
        }
      )
    ).resolves.toEqual({
      ok: false,
      error: 'This pull request requires review approval before it can be merged.'
    })
    expect(mergeArgs()).toBeUndefined()
  })

  it('never bypasses without the caller asking, even when GitHub would allow it', async () => {
    mockPRRequiringApproval({
      number: 44,
      baseRefName: 'bypass-unrequested',
      viewerCanMergeAsAdmin: true
    })

    await expect(mergePR('/repo-root', 44, 'squash', undefined, REPOSITORY)).resolves.toEqual({
      ok: false,
      error: 'This pull request requires review approval before it can be merged.'
    })
    expect(mergeArgs()).toBeUndefined()
  })

  it('keeps the review gate when the probe cannot be answered', async () => {
    mockPRRequiringApproval({
      number: 45,
      baseRefName: 'bypass-unanswered',
      viewerCanMergeAsAdmin: 'unanswered'
    })

    await expect(
      mergePR(
        '/repo-root',
        45,
        'squash',
        undefined,
        REPOSITORY,
        {},
        {
          bypassBranchProtection: true
        }
      )
    ).resolves.toEqual({
      ok: false,
      error: 'This pull request requires review approval before it can be merged.'
    })
    expect(mergeArgs()).toBeUndefined()
  })

  it('refuses a bypass when the base branch might require a merge queue', async () => {
    // Why: an unrun or rate-limited merge-metadata probe leaves the queue status unknown, and the
    // one flag that carries a bypass to GitHub also skips the queue. A lookup with no base ref is
    // exactly how that unknown reaches the preflight.
    mockPRRequiringApproval({
      number: 46,
      baseRefName: undefined,
      viewerCanMergeAsAdmin: true
    })

    await expect(
      mergePR(
        '/repo-root',
        46,
        'squash',
        undefined,
        REPOSITORY,
        {},
        {
          bypassBranchProtection: true
        }
      )
    ).resolves.toEqual({
      ok: false,
      error: 'This pull request requires review approval before it can be merged.'
    })
    expect(mergeArgs()).toBeUndefined()
  })

  it('refuses a bypass while GitHub reports the merge box blocked', async () => {
    // Why: BLOCKED can mean required checks are failing, which the confirmation never covers.
    mockPRRequiringApproval({
      number: 47,
      baseRefName: 'bypass-blocked',
      viewerCanMergeAsAdmin: true,
      mergeStateStatus: 'BLOCKED'
    })

    await expect(
      mergePR(
        '/repo-root',
        47,
        'squash',
        undefined,
        REPOSITORY,
        {},
        {
          bypassBranchProtection: true
        }
      )
    ).resolves.toEqual({
      ok: false,
      error: 'This pull request requires review approval before it can be merged.'
    })
    expect(mergeArgs()).toBeUndefined()
  })
})
