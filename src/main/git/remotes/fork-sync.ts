import { normalizeGitErrorMessage } from '../../../shared/git/remotes/git-remote-error'
import {
  syncForkDefaultBranch,
  type GitForkSyncExpectedUpstream,
  type GitForkSyncResult
} from '../../../shared/git/remotes/git-fork-sync'

import {
  type GitRuntimeOptions,
  gitOptionsForWorktree
} from '../command-runner/git-runtime-options'
import { gitExecFileAsync } from '../command-runner/git-exec-file'
import { abortSignalWithTimeout } from '../../lib/abort-signal-with-timeout'
import { assertAppBoundPushUrl } from './app-bound-push-url'

export async function gitSyncForkDefaultBranch(
  worktreePath: string,
  expectedUpstream: GitForkSyncExpectedUpstream,
  options: GitRuntimeOptions = {}
): Promise<GitForkSyncResult> {
  const signal = abortSignalWithTimeout(options.signal, 60_000)
  try {
    return await syncForkDefaultBranch(
      async (args) => {
        if (args[0] === 'push' && args[1]) {
          await assertAppBoundPushUrl(worktreePath, args[1], options)
        }
        return await gitExecFileAsync(args, {
          ...gitOptionsForWorktree(worktreePath, options),
          timeout: 60_000,
          signal
        })
      },
      { expectedUpstream }
    )
  } catch (error) {
    throw new Error(normalizeGitErrorMessage(error, 'push'))
  }
}
