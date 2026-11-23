// A bot's `gh` and `git` acting as the connected GitHub App, so a bot's comments and commits are authored by
// `slug[bot]` and never by the person who happens to be signed in. Nothing here reaches the CLI's argv.
import { installationToken } from '../github/app/github-app-installation-token'
import { readGithubAppCredentials } from '../github/app/github-app-credentials'
import { electronHttpClient } from '../host/electron-http-client'

export const BOT_GH_APP_TOKEN_ENV = 'GH_TOKEN'

/**
 * The env a bot's commands need to act as the App, or an empty env when no App is connected.
 *
 * A connected App that cannot produce a token fails the launch instead of falling back to the ambient `gh`
 * sign-in: a bot that quietly comments as you is worse than a bot that refuses to start.
 */
export async function botGithubAppEnv(): Promise<Record<string, string>> {
  const credentials = await readGithubAppCredentials()
  if (!credentials) {
    return {}
  }
  const installation = credentials.installations[0]
  if (!installation) {
    throw new Error(
      'The connected GitHub App is installed nowhere, so a bot cannot act as it. Install it, then try again.'
    )
  }
  const token = await installationToken({
    credentials,
    installationId: installation.id,
    fetch: electronHttpClient.fetch
  })
  return { [BOT_GH_APP_TOKEN_ENV]: token, GH_PROMPT_DISABLED: '1' }
}
