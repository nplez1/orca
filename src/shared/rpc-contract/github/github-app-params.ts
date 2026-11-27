import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import type { GithubAppRepositorySelection } from '../../github/app/github-app-identity'
import { requiredNumber, requiredString } from '../rpc-param-primitives'
import { RepoSelector } from './github-repo-target-params'

const GithubAppId = requiredNumber('Missing app id').refine(
  (value) => Number.isInteger(value) && value > 0,
  { message: 'The app id is the whole number on the App’s settings page' }
)

/** `github.app.connect`: the id GitHub shows on the App's settings page, and its downloaded key. */
export const GithubAppConnect = lazyZodSchema(() =>
  z.object({
    appId: GithubAppId,
    privateKey: requiredString('Paste the App’s private key, or pick the .pem file GitHub gave you')
  })
)

export type GithubAppConnectParams = z.infer<typeof GithubAppConnect>

/**
 * `github.app.gitCredential`: git's credential helper asks, so a push mints the token at push time. `path`
 * is the repository git is asking about, which the runtime checks against the project's own remotes.
 */
export const GithubAppGitCredential = RepoSelector.extend({
  path: requiredString(
    'git’s credential request names no repository, so Orca cannot tell which one it is for'
  )
})

export type GithubAppGitCredentialParams = z.infer<typeof GithubAppGitCredential>

/** Git's credential protocol fields: the App's login, and a token minted for this one request. */
export type GithubAppGitCredentialResult = { username: string; password: string }

export type GithubAppInstallationView = {
  id: number
  account: string
  repositorySelection: GithubAppRepositorySelection
  /** `owner/name`; empty for `all`, which covers every repository the installation was given. */
  repositories: string[]
  /** False when the installation cannot push; null when GitHub did not report its permissions. */
  canPush?: boolean | null
  /** False when a push touching `.github/workflows` is refused; null when not reported. */
  canPushWorkflows?: boolean | null
}

/**
 * What is connected, never what it holds: no key and no token, because the renderer needs to show the
 * App's identity, not to act as it.
 */
export type GithubAppStatus =
  | {
      connected: false
      /** Why a stored App could not be read back, so Settings can offer connecting it again. */
      unreadable?: string
    }
  | {
      connected: true
      appId: number
      /** `<slug>[bot]`: who a bot's GitHub actions are authored by. */
      login: string
      installations: GithubAppInstallationView[]
      /** The installation a bot acts as, so Settings names one instead of implying every one is used. */
      activeInstallationId?: number
      /** Known only once a token has been minted; a status read never mints one. */
      tokenExpiresAt?: string
    }
