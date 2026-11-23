// A binding is only as good as the URL git actually pushes to. A user's own `pushInsteadOf` outranks the
// App's `insteadOf` — git rewrites the push URL first and does not rewrite it again — so the URL git will
// use is read back, and a push that would act as the user's own SSH login is refused.
import { GITHUB_APP_HOST } from '../../../shared/github/app/github-app-identity'
import { APP_BOUND_GIT_ENV_MARKER } from '../../github/app/github-app-git-credential-env'
import { gitExecFileAsync } from '../command-runner/git-exec-file'
import {
  gitOptionsForWorktree,
  type GitRuntimeOptions
} from '../command-runner/git-runtime-options'

/** A URL as it can be shown to a person: any credentials in it are dropped. */
function withoutCredentials(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1')
}

/** Throws when `remote`'s effective push URL is not the HTTPS github.com URL the App's token answers. */
export async function assertAppBoundPushUrl(
  worktreePath: string,
  remote: string,
  options: GitRuntimeOptions
): Promise<void> {
  if (!options.env?.[APP_BOUND_GIT_ENV_MARKER]) {
    return
  }
  const { stdout } = await gitExecFileAsync(
    ['remote', 'get-url', '--push', remote],
    gitOptionsForWorktree(worktreePath, options)
  )
  const url = stdout.trim()
  if (url.startsWith(`https://${GITHUB_APP_HOST}/`)) {
    return
  }
  throw new Error(
    `This project pushes as its GitHub App, but “${remote}” resolves to ${withoutCredentials(url) || 'no URL'}, so this push would act as your own GitHub login instead. Point “${remote}” at an https://${GITHUB_APP_HOST}/ URL, remove a user-level pushInsteadOf for it, or clear this project’s GitHub account.`
  )
}
