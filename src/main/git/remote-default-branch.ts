import { promptGuardGitEnv } from './command-runner/git-process-env'
import { gitExecFileAsync } from './runner'
import { parseRemoteHeadBranch } from '../../shared/git-fork-sync'

/** Bounded like the clone itself: a remote that cannot answer HEAD must not stall the create flow. */
const REMOTE_DEFAULT_BRANCH_TIMEOUT_MS = 15_000

/**
 * The branch a remote would check out, resolved *before* the clone so the primary checkout's
 * folder can be named for it. This is the pre-clone spelling of `origin/HEAD`: there is no
 * repository to ask yet, so it is read from the remote's own HEAD symref.
 *
 * Returns null when the remote cannot answer — offline, private without credentials, or an
 * unparseable reply — so the caller fails open to its documented `main` fallback. Credential
 * prompts are guarded the same way the clone guards them, because a Git Credential Manager
 * window raised here would be just as unclosable (#7652).
 */
export async function getRemoteDefaultBranchName(
  url: string,
  options: { cwd: string; signal?: AbortSignal }
): Promise<string | null> {
  try {
    // Why '--' before the URL: a URL that looks like a flag must not be read as one.
    const { stdout } = await gitExecFileAsync(['ls-remote', '--symref', '--', url, 'HEAD'], {
      cwd: options.cwd,
      env: promptGuardGitEnv(),
      timeout: REMOTE_DEFAULT_BRANCH_TIMEOUT_MS,
      ...(options.signal ? { signal: options.signal } : {})
    })
    return parseRemoteHeadBranch(stdout)
  } catch {
    return null
  }
}
