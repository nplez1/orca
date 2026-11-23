// The three calls only an App can make: read itself, list its installations, and mint an installation
// token. Everything else in Orca reaches GitHub through `gh`; these cannot, because they authenticate
// with a JWT signed by the App's own key rather than with any account.
import type { GithubAppInstallation } from './github-app-credentials'
import { signGithubAppJwt } from './github-app-jwt'

const API_ROOT = 'https://api.github.com'
const API_VERSION = '2022-11-28'

/** Injected so a test needs no network and main can pass the proxy-aware client. */
export type GithubAppFetch = (url: string, init: RequestInit) => Promise<Response>

export class GithubAppRequestError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'GithubAppRequestError'
  }
}

function refusal(status: number): string {
  if (status === 401) {
    return 'GitHub refused the App credentials (401): the key and the app id do not belong together'
  }
  if (status === 404) {
    return 'GitHub has no such App or installation (404): check the app id and the installation id'
  }
  if (status === 403) {
    return 'the installation does not permit this call (403)'
  }
  return `GitHub answered ${status}`
}

async function appRequest(
  input: { appId: number; privateKeyPem: string; fetch: GithubAppFetch; nowMs: number },
  path: string,
  init: RequestInit = {}
): Promise<unknown> {
  const response = await input.fetch(`${API_ROOT}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${signGithubAppJwt(input.appId, input.privateKeyPem, input.nowMs)}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
      ...init.headers
    }
  })
  if (!response.ok) {
    throw new GithubAppRequestError(response.status, refusal(response.status))
  }
  return (await response.json()) as unknown
}

export type GithubAppIdentity = { id: number; slug: string }

/** `GET /app`: proves the id and key belong together, and yields the slug the login is derived from. */
export async function readGithubApp(input: {
  appId: number
  privateKeyPem: string
  fetch: GithubAppFetch
  nowMs?: number
}): Promise<GithubAppIdentity> {
  const body = (await appRequest({ ...input, nowMs: input.nowMs ?? Date.now() }, '/app')) as {
    id?: unknown
    slug?: unknown
  }
  if (typeof body.id !== 'number' || typeof body.slug !== 'string' || !body.slug) {
    throw new Error('github-app: GitHub’s app response did not name the App')
  }
  return { id: body.id, slug: body.slug }
}

/** `GET /app/installations`: where the App may act, and on which repos (`selected` names them later). */
export async function listGithubAppInstallations(input: {
  appId: number
  privateKeyPem: string
  fetch: GithubAppFetch
  nowMs?: number
}): Promise<GithubAppInstallation[]> {
  const body = (await appRequest(
    { ...input, nowMs: input.nowMs ?? Date.now() },
    '/app/installations?per_page=100'
  )) as unknown
  if (!Array.isArray(body)) {
    throw new Error('github-app: GitHub’s installations response was not a list')
  }
  return body.flatMap((entry): GithubAppInstallation[] => {
    const record = entry as {
      id?: unknown
      account?: { login?: unknown }
      repository_selection?: unknown
    }
    const selection = record.repository_selection === 'all' ? 'all' : 'selected'
    if (typeof record.id !== 'number' || typeof record.account?.login !== 'string') {
      return []
    }
    return [
      {
        id: record.id,
        account: record.account.login,
        repositorySelection: selection,
        repositories: []
      }
    ]
  })
}

/** `POST /app/installations/{id}/access_tokens`: the token `gh` and `git` act with. */
export async function mintInstallationToken(input: {
  appId: number
  installationId: number
  privateKeyPem: string
  fetch: GithubAppFetch
  nowMs?: number
}): Promise<{ token: string; expiresAtMs: number }> {
  const nowMs = input.nowMs ?? Date.now()
  const body = (await appRequest(
    { ...input, nowMs },
    `/app/installations/${input.installationId}/access_tokens`,
    { method: 'POST' }
  )) as { token?: unknown; expires_at?: unknown }
  if (typeof body.token !== 'string' || !body.token) {
    throw new Error('github-app: GitHub’s token response carried no token')
  }
  const expiresAtMs = typeof body.expires_at === 'string' ? Date.parse(body.expires_at) : Number.NaN
  return { token: body.token, expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : Number.NaN }
}

/** `GET /installation/repositories` with an installation token: which repos a `selected` install covers. */
export async function listInstallationRepositories(input: {
  token: string
  fetch: GithubAppFetch
}): Promise<string[]> {
  const response = await input.fetch(`${API_ROOT}/installation/repositories?per_page=100`, {
    headers: {
      Authorization: `Bearer ${input.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION
    }
  })
  if (!response.ok) {
    throw new GithubAppRequestError(response.status, refusal(response.status))
  }
  const body = (await response.json()) as { repositories?: unknown }
  if (!Array.isArray(body.repositories)) {
    throw new Error('github-app: GitHub’s repository response was not a list')
  }
  return body.repositories.flatMap((entry) => {
    const fullName = (entry as { full_name?: unknown }).full_name
    return typeof fullName === 'string' && fullName ? [fullName] : []
  })
}
