// The connected App's lifecycle on this computer: what is stored, adding one, re-reading it, and removing
// it. The key enters here from the connect RPC and leaves only into the sealed credential file.
import type {
  GithubAppInstallationView,
  GithubAppStatus
} from '../../../shared/rpc-contract/github/github-app-params'
import { githubAppInstallationFor } from '../../../shared/github/app/github-app-identity'
import {
  listGithubAppInstallations,
  listInstallationRepositories,
  mintInstallationToken,
  readGithubApp,
  revokeInstallationToken,
  type GithubAppFetch
} from './github-app-api'
import {
  githubAppLogin,
  readGithubAppCredentials,
  removeGithubAppCredentials,
  writeGithubAppCredentials,
  type GithubAppCredentials,
  type GithubAppInstallation
} from './github-app-credentials'
import { advanceAppIdentityEpoch } from './github-app-identity-epoch'
import {
  cachedInstallationIds,
  cachedInstallationToken,
  cachedInstallationTokenExpiry,
  forgetInstallationTokens
} from './github-app-installation-token'

const PRIVATE_KEY_HEADER = /-----BEGIN (?:RSA )?PRIVATE KEY-----/

/** A pasted key arrives without the file's trailing newline, and a picked one may carry blank lines. */
function normalizePrivateKey(raw: string): string {
  const trimmed = raw.trim()
  if (!PRIVATE_KEY_HEADER.test(trimmed)) {
    throw new Error(
      'That is not a private key: paste the whole .pem GitHub gave you, including the BEGIN and END lines.'
    )
  }
  return `${trimmed}\n`
}

function view(installation: GithubAppInstallation): GithubAppInstallationView {
  return {
    id: installation.id,
    account: installation.account,
    repositorySelection: installation.repositorySelection,
    repositories: [...installation.repositories]
  }
}

/**
 * The last connect, refresh or disconnect this process started. A slow connect that finishes after the
 * user disconnected must not write what it read: the last action wins.
 */
let operation = 0

/** A connect or refresh that a later action overtook: nothing was stored. */
class GithubAppOperationSuperseded extends Error {
  constructor() {
    super(
      'Another GitHub App change was made while this one ran, so nothing was stored. Try again.'
    )
    this.name = 'GithubAppOperationSuperseded'
  }
}

/** The installation a bot acts as when no repository is known: the first, which Settings can name. */
function installationInUse(credentials: GithubAppCredentials): GithubAppInstallation | null {
  return githubAppInstallationFor(credentials.installations)
}

/** When the token for that installation expires; Settings shows it only once a bot has minted one. */
function tokenExpiresAt(credentials: GithubAppCredentials): string | undefined {
  const inUse = installationInUse(credentials)
  const expiresAtMs = inUse ? cachedInstallationTokenExpiry(inUse.id) : null
  return expiresAtMs === null ? undefined : new Date(expiresAtMs).toISOString()
}

export async function githubAppStatus(): Promise<GithubAppStatus> {
  let credentials: GithubAppCredentials | null
  try {
    credentials = await readGithubAppCredentials()
  } catch (error) {
    // A file Orca cannot open is still a connection the user has to fix, so say why rather than "none".
    return {
      connected: false,
      unreadable: error instanceof Error ? error.message : String(error)
    }
  }
  if (!credentials) {
    return { connected: false }
  }
  const expiresAt = tokenExpiresAt(credentials)
  const inUse = installationInUse(credentials)
  return {
    connected: true,
    appId: credentials.appId,
    login: githubAppLogin(credentials.slug),
    installations: credentials.installations.map(view),
    ...(inUse ? { activeInstallationId: inUse.id } : {}),
    ...(expiresAt ? { tokenExpiresAt: expiresAt } : {})
  }
}

/** Which repos a `selected` installation covers: only an installation token can list them. */
async function coveredRepositories(input: {
  appId: number
  privateKeyPem: string
  installation: GithubAppInstallation
  fetch: GithubAppFetch
}): Promise<string[]> {
  const { token } = await mintInstallationToken({
    appId: input.appId,
    installationId: input.installation.id,
    privateKeyPem: input.privateKeyPem,
    fetch: input.fetch
  })
  return listInstallationRepositories({ token, fetch: input.fetch })
}

/** What GitHub says the App is now: its identity, where it may act, and which repos each install covers. */
async function readAppFromGithub(input: {
  appId: number
  privateKeyPem: string
  fetch: GithubAppFetch
}): Promise<{ appId: number; slug: string; installations: GithubAppInstallation[] }> {
  // Proves the id and the key belong together before anything is stored: a mismatch is GitHub's 401.
  const app = await readGithubApp({
    appId: input.appId,
    privateKeyPem: input.privateKeyPem,
    fetch: input.fetch
  })
  const listed = await listGithubAppInstallations({
    appId: app.id,
    privateKeyPem: input.privateKeyPem,
    fetch: input.fetch
  })
  if (listed.length === 0) {
    throw new Error(
      'GitHub has no installation of this App yet, so a bot would have nowhere to act as it. Install the App on the repositories it should work in, then add it here.'
    )
  }
  const installations = await Promise.all(
    listed.map(async (installation): Promise<GithubAppInstallation> =>
      installation.repositorySelection === 'all'
        ? installation
        : {
            ...installation,
            repositories: await coveredRepositories({
              appId: app.id,
              privateKeyPem: input.privateKeyPem,
              installation,
              fetch: input.fetch
            })
          }
    )
  )
  return { appId: app.id, slug: app.slug, installations }
}

export async function connectGithubApp(input: {
  appId: number
  privateKey: string
  fetch: GithubAppFetch
}): Promise<GithubAppStatus> {
  const privateKeyPem = normalizePrivateKey(input.privateKey)
  const seq = ++operation
  const app = await readAppFromGithub({ appId: input.appId, privateKeyPem, fetch: input.fetch })
  if (seq !== operation) {
    throw new GithubAppOperationSuperseded()
  }
  await writeGithubAppCredentials({ ...app, privateKeyPem })
  // A re-key must not keep acting with a token minted by the key it replaced.
  forgetInstallationTokens()
  advanceAppIdentityEpoch()
  return githubAppStatus()
}

/**
 * Re-reads the stored App from GitHub and rewrites what is stored: a repository added to an installation,
 * or a new installation, needs no second paste. The identity does not change, so running sessions keep
 * the token they launched with.
 */
export async function refreshGithubApp(input: { fetch: GithubAppFetch }): Promise<GithubAppStatus> {
  const credentials = await readGithubAppCredentials()
  if (!credentials) {
    throw new Error('No GitHub App is connected on this computer.')
  }
  const seq = ++operation
  const app = await readAppFromGithub({
    appId: credentials.appId,
    privateKeyPem: credentials.privateKeyPem,
    fetch: input.fetch
  })
  if (seq !== operation) {
    throw new GithubAppOperationSuperseded()
  }
  await writeGithubAppCredentials({ ...app, privateKeyPem: credentials.privateKeyPem })
  return githubAppStatus()
}

/** Best effort: a token GitHub will not revoke (or a network that is down) must not block a disconnect. */
async function revokeMintedTokens(fetch: GithubAppFetch): Promise<void> {
  const ids = cachedInstallationIds()
  await Promise.allSettled(
    ids.flatMap((id) => {
      const token = cachedInstallationToken(id)
      return token ? [revokeInstallationToken({ token, fetch })] : []
    })
  )
}

export async function disconnectGithubApp(input: { fetch: GithubAppFetch }): Promise<void> {
  // A connect still in flight is superseded by this, so it cannot write afterwards.
  operation += 1
  await revokeMintedTokens(input.fetch)
  await removeGithubAppCredentials()
  forgetInstallationTokens()
  advanceAppIdentityEpoch()
}
