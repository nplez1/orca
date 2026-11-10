import type * as GitExecFileModule from '../git/command-runner/git-exec-file'
import type * as GhExecFileModule from '../git/command-runner/gh-exec-file'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GithubApiRepositoryModule from './github-api-repository'
import type * as GitHubEnterpriseRepositoryModule from './github-enterprise-repository'

const { clientMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('./client-test-mocks')
  return { clientMocks: moduleMocks.createGitHubClientMocks(), moduleMocks }
})

vi.mock('./gh-utils', () => moduleMocks.ghUtilsModuleMock(clientMocks))
vi.mock('../git/runner', () => moduleMocks.gitRunnerModuleMock(clientMocks))

vi.mock('../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<typeof GitExecFileModule>()),
  gitExecFileAsync: clientMocks.gitExecFileAsyncMock
}))

vi.mock('../git/command-runner/gh-exec-file', async (importOriginal) => ({
  ...(await importOriginal<typeof GhExecFileModule>()),
  ghExecFileAsync: clientMocks.ghExecFileAsyncMock
}))
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

import { getPRForBranch } from './client/lookup/get-pr-for-branch'
import { installIndependentCheckFixtures, resetPRForBranchMocks } from './client-test-harness'

const { getOwnerRepoMock, ghExecFileAsyncMock, resolvePRRepositoryCandidatesMock } = clientMocks

const metadataRequests = vi.fn()
const unexpectedChecks: string[][] = []
afterEach(() => expect(unexpectedChecks).toEqual([]))

describe('getPRForBranch', () => {
  beforeEach(() => {
    resetPRForBranchMocks(clientMocks)
    installIndependentCheckFixtures(clientMocks, metadataRequests, unexpectedChecks)
  })

  it('does not fall back to branch discovery when linked PR metadata is stale', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    metadataRequests.mockRejectedValueOnce(new Error('HTTP 404: Not Found')).mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 42,
          title: 'Branch PR',
          state: 'OPEN',
          url: 'https://github.com/acme/widgets/pull/42',
          statusCheckRollup: [],
          updatedAt: '2026-03-28T00:00:00Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'feature/test',
          baseRefOid: 'base-oid',
          headRefOid: 'head-oid'
        }
      ])
    })

    const pr = await getPRForBranch('/repo-root', 'feature/test', 99)

    expect(metadataRequests).toHaveBeenNthCalledWith(
      1,
      [
        'pr',
        'view',
        '99',
        '--repo',
        'acme/widgets',
        '--json',
        'number,title,state,url,updatedAt,isDraft,mergeable,reviewDecision,mergeStateStatus,autoMergeRequest,baseRefName,headRefName,baseRefOid,headRefOid,headRepositoryOwner,headRepository,isCrossRepository'
      ],
      { cwd: '/repo-root' }
    )
    expect(metadataRequests).toHaveBeenCalledTimes(1)
    expect(pr).toBeNull()
  })

  it('picks the candidate whose head ref matches when a fork shares a PR number with upstream', async () => {
    // Why: a fork and its upstream number independently, so both can hold a PR with one number —
    // and the upstream one is an unrelated PR the worktree never opened. The head ref separates them.
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
      candidates: [
        { owner: 'stablyai', repo: 'orca' },
        { owner: 'nplez1', repo: 'orca' }
      ],
      headRepo: { owner: 'nplez1', repo: 'orca' }
    })
    // Through the metadata seam, so each candidate's independent check fetch gets its own fixture.
    metadataRequests
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 3,
          title: 'Add Shift+Enter to insert newline in terminal',
          state: 'MERGED',
          url: 'https://github.com/stablyai/orca/pull/3',
          statusCheckRollup: [],
          updatedAt: '2026-03-28T00:00:00Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'feature/unrelated',
          baseRefOid: 'base-oid',
          headRefOid: 'other-head-oid'
        })
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 3,
          title: 'Move main-thread stalls off the main thread',
          state: 'OPEN',
          url: 'https://github.com/nplez1/orca/pull/3',
          statusCheckRollup: [],
          updatedAt: '2026-03-28T00:00:00Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'nplez1/beachball',
          baseRefOid: 'base-oid',
          headRefOid: 'head-oid'
        })
      })

    const pr = await getPRForBranch('/repo-root', 'nplez1/beachball', 3)

    // Both candidates are probed, so the unrelated upstream PR cannot end the search.
    const probedRepos = ghExecFileAsyncMock.mock.calls
      .filter(([args]) => args[0] === 'pr' && args[1] === 'view')
      .map(([args]) => args[4])
    expect(probedRepos).toEqual(['stablyai/orca', 'nplez1/orca'])
    expect(pr?.url).toBe('https://github.com/nplez1/orca/pull/3')
    expect(pr?.prRepo).toEqual({ owner: 'nplez1', repo: 'orca' })
  })

  it('keeps the first candidate when no candidate head ref matches the worktree branch', async () => {
    // Why: a worktree created from a PR keeps a local branch that differs from the PR head ref,
    // so a number whose head ref matches nothing must still resolve rather than read as missing.
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
      candidates: [
        { owner: 'stablyai', repo: 'orca' },
        { owner: 'nplez1', repo: 'orca' }
      ],
      headRepo: { owner: 'nplez1', repo: 'orca' }
    })
    ghExecFileAsyncMock.mockResolvedValue({
      stdout: JSON.stringify({
        number: 3,
        title: 'Linked PR',
        state: 'OPEN',
        url: 'https://github.com/stablyai/orca/pull/3',
        statusCheckRollup: [],
        updatedAt: '2026-03-28T00:00:00Z',
        isDraft: false,
        mergeable: 'MERGEABLE',
        baseRefName: 'main',
        headRefName: 'contributor/original',
        baseRefOid: 'base-oid',
        headRefOid: 'head-oid'
      })
    })

    const pr = await getPRForBranch('/repo-root', 'local-created-from-pr', 3)

    expect(pr?.number).toBe(3)
    expect(pr?.prRepo).toEqual({ owner: 'stablyai', repo: 'orca' })
  })
})
