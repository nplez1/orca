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

/** GitHub's JSON as fields to narrow; a non-object answers as none, which every caller then refuses. */
function fields(value: unknown): Record<string, unknown> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the typeof guard proves an object
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function refusal(status: number): string {
  if (status === 401) {
    return 'GitHub refused the App credentials (401): the key and the app id do not belong together'
  }
  if (status === 404) {
    return 'GitHub has no such App (404): check the app id, and that the key is the one this App gave you'
  }
  if (status === 403) {
    return 'the installation does not permit this call (403)'
  }
  return `GitHub answered ${status}`
}

/** A list is capped rather than followed forever if GitHub keeps naming a next page. */
const MAX_LIST_PAGES = 20

/** GitHub's `Link` header names the next page; nothing else does, so it is how a list past 100 is read. */
function nextPageUrl(link: string | null): string | null {
  if (!link) {
    return null
  }
  for (const part of link.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part)
    if (match?.[1]) {
      return match[1]
    }
  }
  return null
}

function absolute(url: string): string {
  return url.startsWith('http') ? url : `${API_ROOT}${url}`
}

async function appRequest(
  input: { appId: number; privateKeyPem: string; fetch: GithubAppFetch; nowMs: number },
  path: string,
  init: RequestInit = {}
): Promise<{ body: unknown; next: string | null }> {
  const response = await input.fetch(absolute(path), {
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
  const body: unknown = await response.json()
  return { body, next: nextPageUrl(response.headers.get('link')) }
}

/** Every page of one of GitHub's lists: an App installed in more than 100 places is not cut off silently. */
async function appList(
  input: { appId: number; privateKeyPem: string; fetch: GithubAppFetch; nowMs: number },
  path: string
): Promise<unknown[]> {
  const entries: unknown[] = []
  let next: string | null = path
  for (let page = 0; next && page < MAX_LIST_PAGES; page += 1) {
    const answer: { body: unknown; next: string | null } = await appRequest(input, next)
    if (!Array.isArray(answer.body)) {
      throw new Error('github-app: GitHub’s list response was not a list')
    }
    entries.push(...answer.body)
    next = answer.next
  }
  return entries
}

export type GithubAppIdentity = { id: number; slug: string }

/** `GET /app`: proves the id and key belong together, and yields the slug the login is derived from. */
export async function readGithubApp(input: {
  appId: number
  privateKeyPem: string
  fetch: GithubAppFetch
  nowMs?: number
}): Promise<GithubAppIdentity> {
  const answer = await appRequest({ ...input, nowMs: input.nowMs ?? Date.now() }, '/app')
  const body = fields(answer.body)
  if (typeof body.id !== 'number' || typeof body.slug !== 'string' || !body.slug) {
    throw new Error('github-app: GitHub’s app response did not name the App')
  }
  return { id: body.id, slug: body.slug }
}

export async function listGithubAppInstallations(input: {
  appId: number
  privateKeyPem: string
  fetch: GithubAppFetch
  nowMs?: number
}): Promise<GithubAppInstallation[]> {
  const entries = await appList(
    { ...input, nowMs: input.nowMs ?? Date.now() },
    '/app/installations?per_page=100'
  )
  return entries.flatMap((entry): GithubAppInstallation[] => {
    const record = fields(entry)
    const selection = record.repository_selection === 'all' ? 'all' : 'selected'
    const account = fields(record.account).login
    if (typeof record.id !== 'number' || typeof account !== 'string') {
      return []
    }
    const contentsWrite = readWritePermission(record, 'contents')
    const workflowsWrite = readWritePermission(record, 'workflows')
    return [
      {
        id: record.id,
        account,
        repositorySelection: selection,
        repositories: [],
        ...(contentsWrite === null ? {} : { contentsWrite }),
        ...(workflowsWrite === null ? {} : { workflowsWrite })
      }
    ]
  })
}

/**
 * One permission the installation holds, from GitHub's own installation object. Absent means null (not
 * verified) rather than false, so nothing claims a push will be rejected without having read it.
 */
function readWritePermission(installation: Record<string, unknown>, key: string): boolean | null {
  const value = fields(installation.permissions)[key]
  if (value === 'write') {
    return true
  }
  return value === undefined ? null : false
}

export async function mintInstallationToken(input: {
  appId: number
  installationId: number
  privateKeyPem: string
  fetch: GithubAppFetch
  nowMs?: number
}): Promise<{ token: string; expiresAtMs: number }> {
  const nowMs = input.nowMs ?? Date.now()
  const body = fields(
    (
      await appRequest(
        { ...input, nowMs },
        `/app/installations/${input.installationId}/access_tokens`,
        {
          method: 'POST'
        }
      )
    ).body
  )
  if (typeof body.token !== 'string' || !body.token) {
    throw new Error('github-app: GitHub’s token response carried no token')
  }
  const expiresAtMs = typeof body.expires_at === 'string' ? Date.parse(body.expires_at) : Number.NaN
  return { token: body.token, expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : Number.NaN }
}

export async function listInstallationRepositories(input: {
  token: string
  fetch: GithubAppFetch
}): Promise<string[]> {
  const repositories: string[] = []
  let url: string | null = `${API_ROOT}/installation/repositories?per_page=100`
  for (let page = 0; url && page < MAX_LIST_PAGES; page += 1) {
    const response = await input.fetch(url, {
      headers: {
        Authorization: `Bearer ${input.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': API_VERSION
      }
    })
    if (!response.ok) {
      throw new GithubAppRequestError(response.status, refusal(response.status))
    }
    const body = fields(await response.json())
    if (!Array.isArray(body.repositories)) {
      throw new Error('github-app: GitHub’s repository response was not a list')
    }
    const entries: unknown[] = body.repositories
    repositories.push(
      ...entries.flatMap((entry) => {
        const fullName = fields(entry).full_name
        return typeof fullName === 'string' && fullName ? [fullName] : []
      })
    )
    url = nextPageUrl(response.headers.get('link'))
  }
  return repositories
}

/** `DELETE /installation/token`: a token Orca minted stops working the moment the App is disconnected. */
export async function revokeInstallationToken(input: {
  token: string
  fetch: GithubAppFetch
}): Promise<void> {
  const response = await input.fetch(`${API_ROOT}/installation/token`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${input.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION
    }
  })
  if (!response.ok) {
    throw new GithubAppRequestError(response.status, refusal(response.status))
  }
}
