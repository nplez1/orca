import { describe, expect, it, vi } from 'vitest'
import type * as GitHubClientModule from '../github/client'
import type { LocalProjectGhExecOptions } from '../project-runtime-git-options'

const mergePRMock = vi.hoisted(() => vi.fn(async () => ({ ok: true as const })))

vi.mock('../github/client', async (importOriginal) => ({
  ...(await importOriginal<typeof GitHubClientModule>()),
  mergePR: mergePRMock
}))

import { RuntimeGitHubReviewMutationCommands } from './runtime-github-review-mutation-commands'

const REPO = {
  id: 'repo-1',
  path: '/workspace/repo',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 0
}

const PR_REPO = { owner: 'acme', repo: 'orca' }

type LocalGitArgs = [] | [LocalProjectGhExecOptions]

function createCommands(getLocalGitArgs: () => LocalGitArgs): RuntimeGitHubReviewMutationCommands {
  return new RuntimeGitHubReviewMutationCommands({
    resolveRepo: async () => REPO,
    getLocalGitArgs
  })
}

/**
 * `mergeRepoPR` is the paired-host twin of the `gh:mergePR` IPC handler, and both hand `mergePR` a
 * trailing options object after a local-git-options argument that may be the empty list. Spreading
 * that empty list used to shift the options into the `localGitOptions` slot, so the bypass the user
 * had confirmed was silently never authorised and the merge was refused instead.
 */
describe('RuntimeGitHubReviewMutationCommands.mergeRepoPR', () => {
  it('passes a confirmed admin bypass when the repo has no local git options', async () => {
    const commands = createCommands(() => [])

    await commands.mergeRepoPR('id:repo-1', 42, 'squash', PR_REPO, true)

    expect(mergePRMock).toHaveBeenCalledWith(
      '/workspace/repo',
      42,
      'squash',
      null,
      PR_REPO,
      {},
      { bypassBranchProtection: true }
    )
  })

  it('keeps local git options in their own argument when the repo has them', async () => {
    const localGitOptions = { wslDistro: 'Ubuntu' }
    const commands = createCommands(() => [localGitOptions])

    await commands.mergeRepoPR('id:repo-1', 42, 'squash', PR_REPO, true)

    expect(mergePRMock).toHaveBeenCalledWith(
      '/workspace/repo',
      42,
      'squash',
      null,
      PR_REPO,
      localGitOptions,
      { bypassBranchProtection: true }
    )
  })

  it('never authorises a bypass the caller did not confirm', async () => {
    const commands = createCommands(() => [])

    await commands.mergeRepoPR('id:repo-1', 42, 'squash', PR_REPO)

    expect(mergePRMock).toHaveBeenCalledWith(
      '/workspace/repo',
      42,
      'squash',
      null,
      PR_REPO,
      {},
      { bypassBranchProtection: false }
    )
  })
})
