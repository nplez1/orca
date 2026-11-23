// The installation token a bound App acts with. A user binding asks gh for a token; an App binding has no
// gh to ask, so it mints one from the App's own key, for the installation covering the repository's owner.
import {
  GITHUB_APP_HOST,
  githubAppInstallationFor,
  githubAppInstallationForOwner
} from '../../../shared/github/app/github-app-identity'
import { createGhBoundAccountUnavailableError } from '../accounts/gh-bound-account-errors'
import type { GithubAppFetch } from './github-app-api'
import type { GithubAppCredentials } from './github-app-credentials'
import { installationToken } from './github-app-installation-token'

/** The App's token is a github.com token: there is no App path on a GitHub Enterprise host. */
export { GITHUB_APP_HOST }

export type BoundAppToken = { token: string; installationId: number; expiresAtMs: number }

/** The installation that can act on any repository `owner` owns, from the stored credentials. */
export function appInstallationForOwner(
  installations: GithubAppCredentials['installations'],
  owner: string
): GithubAppCredentials['installations'][number] | null {
  return githubAppInstallationForOwner(installations, owner)
}

/**
 * Mints the token for the installation covering `owner` on `host`, or throws the bound-account error that
 * says which of the three things is missing. Never falls back to the ambient login: the App and a person
 * write different commits, so acting as one when the other was asked for is worse than failing.
 *
 * `owner` is absent for a call that names no repository (`gh api /user`); the first installation is then
 * the only answer, exactly as a bot launch with no known repository uses it.
 */
export async function githubAppBoundToken(input: {
  host: string
  owner?: string | null
  credentials: GithubAppCredentials | null
  fetch: GithubAppFetch
  nowMs?: number
}): Promise<BoundAppToken> {
  const host = input.host.trim().toLowerCase() || GITHUB_APP_HOST
  const owner = input.owner?.trim() ?? ''
  const unavailable = (reason: string) =>
    createGhBoundAccountUnavailableError(
      { host, user: owner || GITHUB_APP_HOST, kind: 'app' },
      reason
    )

  if (host !== GITHUB_APP_HOST) {
    throw unavailable(
      `The GitHub App Orca is connected to acts on ${GITHUB_APP_HOST} only, so it cannot act on ${host}. Bind a gh account for this project instead.`
    )
  }
  if (!input.credentials) {
    throw unavailable(
      `No GitHub App is connected on this computer, so ${owner || 'this project'} cannot act as one. Connect the App in Settings › Bots, or bind a gh account for this project.`
    )
  }
  const installation = owner
    ? githubAppInstallationForOwner(input.credentials.installations, owner)
    : githubAppInstallationFor(input.credentials.installations)
  if (!installation) {
    throw unavailable(
      owner
        ? `The connected GitHub App is not installed on ${owner}’s repositories, so it cannot act there. Install the App on that account, then Refresh it in Settings › Bots.`
        : 'The connected GitHub App is installed nowhere, so it cannot act. Install it on GitHub, then Refresh it in Settings › Bots.'
    )
  }
  const minted = await installationToken({
    credentials: input.credentials,
    installationId: installation.id,
    fetch: input.fetch,
    ...(input.nowMs === undefined ? {} : { nowMs: input.nowMs })
  })
  return { token: minted.token, installationId: installation.id, expiresAtMs: minted.expiresAtMs }
}
