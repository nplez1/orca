import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitHubPRRefreshCandidate } from '../../shared/github/pull-request-refresh-types'
import { hostedReviewOptionArgs, refreshKey } from './pr-refresh-candidate-policy'

const { coordinatorMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('./pr-refresh-coordinator-test-mocks')
  return { coordinatorMocks: moduleMocks.createPRRefreshCoordinatorMocks(), moduleMocks }
})

vi.mock('electron', () => moduleMocks.electronModuleMock(coordinatorMocks))
vi.mock('./client', () => moduleMocks.clientModuleMock(coordinatorMocks))
vi.mock('./github-api-repository', () =>
  moduleMocks.githubApiRepositoryModuleMock(coordinatorMocks)
)
vi.mock('./rate-limit', () => moduleMocks.rateLimitModuleMock(coordinatorMocks))
vi.mock('../ipc/ui', () => moduleMocks.ipcUiModuleMock(coordinatorMocks))

import { makeCandidate, makePR } from './pr-refresh-coordinator-test-harness'

const { getPRForBranchOutcomeMock } = coordinatorMocks
const bound = { host: 'github.com', user: 'Alice' }

/** Options object the drainer handed the lookup, or undefined when it passed none. */
function lookupOptions(callIndex = 0): Record<string, unknown> | undefined {
  return getPRForBranchOutcomeMock.mock.calls[callIndex]?.[5]
}

describe('background PR refresh account binding', () => {
  beforeEach(() => {
    moduleMocks.resetPRRefreshCoordinatorMocks(coordinatorMocks)
    getPRForBranchOutcomeMock.mockResolvedValue({
      kind: 'found',
      pr: makePR({ checksStatus: 'success' }),
      fetchedAt: Date.now()
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('refreshes a bound repo as its pinned account', async () => {
    const candidate = makeCandidate({ localGitOptions: { ghAccount: bound } })
    const { enqueuePRRefresh } = await import('./pr-refresh-coordinator')

    enqueuePRRefresh(candidate, 'active', 80, 1)
    await vi.advanceTimersByTimeAsync(0)

    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
    expect(lookupOptions()?.localGitExecOptions).toEqual({
      ghAccount: bound,
      admissionTier: 'background'
    })
  })

  it('keeps the WSL runtime beside the pinned account', async () => {
    const candidate = makeCandidate({
      localGitOptions: { wslDistro: 'Ubuntu', ghAccount: bound }
    })
    const { enqueuePRRefresh } = await import('./pr-refresh-coordinator')

    enqueuePRRefresh(candidate, 'active', 80, 1)
    await vi.advanceTimersByTimeAsync(0)

    expect(lookupOptions()?.localGitExecOptions).toEqual({
      wslDistro: 'Ubuntu',
      ghAccount: bound,
      admissionTier: 'background'
    })
  })

  it('leaves an unbound repo on the ambient login', async () => {
    const { enqueuePRRefresh } = await import('./pr-refresh-coordinator')

    enqueuePRRefresh(makeCandidate(), 'active', 80, 1)
    await vi.advanceTimersByTimeAsync(0)

    const localGitExecOptions = lookupOptions()?.localGitExecOptions
    // Why: toEqual is exact over own keys, so this also proves no ghAccount key was added.
    expect(localGitExecOptions).toEqual({ admissionTier: 'background' })
  })

  it('re-polls a visible worktree as the new account after a rebind', async () => {
    const rebound = { host: 'github.com', user: 'Bob' }
    const { reportVisiblePRRefreshCandidates } = await import('./pr-refresh-coordinator')

    reportVisiblePRRefreshCandidates(
      [makeCandidate({ localGitOptions: { ghAccount: bound }, isSelected: true })],
      1,
      1
    )
    await vi.advanceTimersByTimeAsync(0)

    // Why: the queue keeps the candidate it last ran, so without an account-scoped key the
    // next visible refresh would keep polling as the account the repo no longer pins.
    reportVisiblePRRefreshCandidates(
      [makeCandidate({ localGitOptions: { ghAccount: rebound }, isSelected: true })],
      2,
      1
    )
    await vi.advanceTimersByTimeAsync(10 * 60_000)

    const accounts = getPRForBranchOutcomeMock.mock.calls.map(
      (call) => call[5]?.localGitExecOptions?.ghAccount
    )
    expect(accounts.at(-1)).toEqual(rebound)
  })
})

describe('hostedReviewOptionArgs ghAccount forwarding', () => {
  const candidateWith = (
    localGitOptions?: GitHubPRRefreshCandidate['localGitOptions']
  ): Parameters<typeof hostedReviewOptionArgs>[0] => ({
    localGitOptions,
    linkedPRNumber: null,
    fallbackPRNumber: null,
    fallbackPRSource: null,
    currentHeadOid: null
  })

  it('carries the binding into the lookup options', () => {
    expect(hostedReviewOptionArgs(candidateWith({ ghAccount: bound }))[0]).toMatchObject({
      localGitExecOptions: { ghAccount: bound }
    })
  })

  it('omits the key when the candidate is unbound', () => {
    const [options] = hostedReviewOptionArgs(candidateWith({ wslDistro: 'Ubuntu' }))
    expect(options?.localGitExecOptions).toEqual({
      wslDistro: 'Ubuntu',
      admissionTier: 'background'
    })
  })

  it('scopes the refresh key by account so a rebind is a different entry', () => {
    const keyFor = (localGitOptions?: GitHubPRRefreshCandidate['localGitOptions']): string =>
      refreshKey(makeCandidate({ localGitOptions }))

    expect(keyFor({ ghAccount: bound })).not.toBe(keyFor({ ghAccount: { ...bound, user: 'Bob' } }))
    expect(keyFor({ ghAccount: bound })).not.toBe(keyFor({ wslDistro: 'Ubuntu' }))
    expect(keyFor({ ghAccount: bound })).toContain('github.com/Alice')
  })
})
