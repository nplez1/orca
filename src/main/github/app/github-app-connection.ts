// The connected App's lifecycle on this computer: what is stored, adding one, and removing it. The key
// enters here from the connect RPC and leaves only into the sealed credential file.
import type {
  GithubAppInstallationView,
  GithubAppStatus
} from '../../../shared/rpc-contract/github/github-app-params'
import {
  listGithubAppInstallations,
  listInstallationRepositories,
  mintInstallationToken,
  readGithubApp,
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
import {
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

/** A bot acts as the first installation, so its token is the one whose expiry Settings can name. */
function tokenExpiresAt(credentials: GithubAppCredentials): string | undefined {
  const first = credentials.installations[0]
  const expiresAtMs = first ? cachedInstallationTokenExpiry(first.id) : null
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
  return {
    connected: true,
    appId: credentials.appId,
    login: githubAppLogin(credentials.slug),
    installations: credentials.installations.map(view),
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

export async function connectGithubApp(input: {
  appId: number
  privateKey: string
  fetch: GithubAppFetch
}): Promise<GithubAppStatus> {
  const privateKeyPem = normalizePrivateKey(input.privateKey)
  // Proves the id and the key belong together before anything is stored: a mismatch is GitHub's 401.
  const app = await readGithubApp({ appId: input.appId, privateKeyPem, fetch: input.fetch })
  const listed = await listGithubAppInstallations({
    appId: app.id,
    privateKeyPem,
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
              privateKeyPem,
              installation,
              fetch: input.fetch
            })
          }
    )
  )
  await writeGithubAppCredentials({ appId: app.id, slug: app.slug, privateKeyPem, installations })
  // A re-key must not keep acting with a token minted by the key it replaced.
  forgetInstallationTokens()
  return githubAppStatus()
}

export async function disconnectGithubApp(): Promise<void> {
  await removeGithubAppCredentials()
  forgetInstallationTokens()
}
