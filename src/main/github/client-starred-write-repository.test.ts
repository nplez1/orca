import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GithubApiRepositoryModule from './github-api-repository'
import type * as GitHubEnterpriseRepositoryModule from './github-enterprise-repository'

const { clientMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('./client-test-mocks')
  return { clientMocks: moduleMocks.createGitHubClientMocks(), moduleMocks }
})

vi.mock('./gh-utils', () => moduleMocks.ghUtilsModuleMock(clientMocks))
vi.mock('../git/runner', () => moduleMocks.gitRunnerModuleMock(clientMocks))
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

import { __resetOrcaStarCheckForTests, checkOrcaStarred, starOrca } from './client/fetch/orca-star'
import { resetOriginRepositoryCache } from './client-test-harness'
import { ORCA_REPOSITORY } from '../../shared/orca-repository'

const { execFileAsyncMock, ghExecFileAsyncMock, acquireMock, releaseMock } = clientMocks

function starPath(args: unknown): string {
  const slug = Array.isArray(args)
    ? args.find((arg) => typeof arg === 'string' && arg.includes('/'))
    : undefined
  return typeof slug === 'string' ? slug.replace(/^user\/starred\//, '') : ''
}

describe('starOrca repository target', () => {
  beforeEach(() => {
    resetOriginRepositoryCache()
    execFileAsyncMock.mockReset()
    ghExecFileAsyncMock.mockReset()
    acquireMock.mockReset()
    releaseMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
    __resetOrcaStarCheckForTests()
  })

  it('stars the repository this build publishes from through the bounded gh runner', async () => {
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '', stderr: '' })

    await expect(starOrca()).resolves.toBe(true)

    expect(execFileAsyncMock).not.toHaveBeenCalled()
    const [args, options] = ghExecFileAsyncMock.mock.calls[0]
    // Why the constant and not a literal: this build's repository is whatever the release feed
    // publishes from, so a star write re-pointed back at upstream fails here.
    expect(args).toEqual(['api', '-X', 'PUT', `user/starred/${ORCA_REPOSITORY}`])
    expect(options.timeout).toBeGreaterThan(0)
    expect(releaseMock).toHaveBeenCalledTimes(1)
  })

  it('points the star write and the star check at one repository', async () => {
    ghExecFileAsyncMock.mockResolvedValue({ stdout: 'HTTP/2.0 204 No Content\r\n', stderr: '' })

    await checkOrcaStarred()
    await starOrca()

    const readSlug = starPath(ghExecFileAsyncMock.mock.calls[0][0])
    const writeSlug = starPath(ghExecFileAsyncMock.mock.calls[1][0])
    // A check that credits the fork while the button stars upstream is the drift this pins.
    expect(readSlug).toBe(ORCA_REPOSITORY)
    expect(writeSlug).toBe(ORCA_REPOSITORY)
    expect(writeSlug).not.toBe('stablyai/orca')
  })
})
