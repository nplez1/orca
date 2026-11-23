// A bot's `gh` acting as the connected GitHub App, so a bot's comments, reviews and pull requests are
// authored by `slug[bot]` and never by the person who happens to be signed in.
import { isPathInsideOrEqual } from '../../shared/file-access/cross-platform-path'
import {
  githubAppInstallationFor,
  githubAppTokenNeedsRefresh
} from '../../shared/github/app/github-app-identity'
import { readGithubAppCredentials } from '../github/app/github-app-credentials'
import { appIdentityEpoch } from '../github/app/github-app-identity-epoch'
import {
  cachedInstallationTokenExpiry,
  installationToken
} from '../github/app/github-app-installation-token'
import { electronHttpClient } from '../host/electron-http-client'

export const BOT_GH_APP_TOKEN_ENV = 'GH_TOKEN'

/**
 * What one launch's `gh` acts as: the env its commands need, the installation they act as (null when no App
 * is connected), and the identity epoch they launched under, so a later change can be told apart.
 */
export type BotGithubAppLaunch = {
  env: Record<string, string>
  installationId: number | null
  epoch: number
}

/**
 * The env a bot's commands need to act as the App, or an empty env when no App is connected.
 *
 * A connected App that cannot produce a token fails the launch instead of falling back to the ambient `gh`
 * sign-in: a bot that quietly comments as you is worse than a bot that refuses to start.
 */
export async function botGithubAppLaunch(
  input: {
    /** `owner/name` of the repo this launch is for, when Orca knows one. */
    repoFullName?: string
  } = {}
): Promise<BotGithubAppLaunch> {
  const epoch = appIdentityEpoch()
  const credentials = await readGithubAppCredentials()
  if (!credentials) {
    return { env: {}, installationId: null, epoch }
  }
  const installation = githubAppInstallationFor(credentials.installations, input.repoFullName)
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
  return {
    env: { [BOT_GH_APP_TOKEN_ENV]: token, GH_PROMPT_DISABLED: '1' },
    installationId: installation.id,
    epoch
  }
}

/** A repo as far as this needs it: where it is on disk, and the remote key that names it on GitHub. */
export type LaunchRepo = { path: string; gitRemoteIdentity?: { canonicalKey: string } | null }

/** The identity a launch recorded, as `BotLaunchedTools.appIdentity` holds it. */
export type LaunchedAppIdentity = { epoch: number; installationId: number | null }

/**
 * Whether the App a session launched as still holds: a connect or a disconnect since then, or a token
 * inside the refresh margin — which would otherwise 401 an hour into a bot's chat.
 */
export function botGithubAppIdentityOutdated(
  launched: LaunchedAppIdentity,
  nowMs: number = Date.now()
): boolean {
  if (appIdentityEpoch() !== launched.epoch) {
    return true
  }
  return (
    launched.installationId !== null &&
    githubAppTokenNeedsRefresh(cachedInstallationTokenExpiry(launched.installationId), nowMs)
  )
}

const GITHUB_HOST = 'github.com'

/**
 * The `owner/name` of the repository a launch directory sits in, when Orca already knows one. A bot's own
 * home is not in a repository, so this is usually nothing — and then the App's first installation is used.
 */
export function githubRepoFullNameOfLaunch(
  repos: readonly LaunchRepo[],
  launchDirectory: string
): string | undefined {
  const candidates = repos
    .filter((repo) => repo.path && isPathInsideOrEqual(repo.path, launchDirectory))
    // The deepest match wins: a repository inside another one's folder is the one being worked in.
    .sort((a, b) => b.path.length - a.path.length)
  for (const repo of candidates) {
    const key = repo.gitRemoteIdentity?.canonicalKey?.trim()
    if (!key) {
      continue
    }
    const [host, ...tail] = key.split('/')
    if (host?.toLowerCase() === GITHUB_HOST && tail.length === 2) {
      return tail.join('/')
    }
  }
  return undefined
}
