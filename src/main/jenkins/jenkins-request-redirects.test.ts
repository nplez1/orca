// The credential-scope boundary for a *configured* Jenkins: a same-origin hop keeps `Authorization`
// (the Fetch standard only strips it cross-origin), so the configured path prefix has to be enforced
// before the token travels — refusing to read the answer afterwards is too late.
import { describe, expect, it, vi } from 'vitest'

const BASE = 'https://ci.example.com/jenkins'

let hops: { url: string; authorization: string | null }[] = []
let hopRoute: (url: string) => Response = () => new Response(null, { status: 404 })
let plainRequests: string[] = []

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } })
}

async function loadRequest() {
  vi.resetModules()
  vi.doMock('../network/proxy-settings', () => ({
    ensureElectronProxyFromEnvironment: async () => undefined
  }))
  const { setMainHttpClient } = await import('../network/http-client')
  setMainHttpClient({
    fetch: async (url) => {
      plainRequests.push(String(url))
      return json({ unreachable: true })
    },
    fetchManualRedirects: async (url, init) => {
      const headers = new Headers(init?.headers)
      hops.push({ url: String(url), authorization: headers.get('authorization') })
      return hopRoute(String(url))
    },
    proxySession: () => null
  })
  return import('./jenkins-request')
}

const configured = {
  username: 'ada',
  apiToken: 's3cret',
  configured: true,
  serverBaseUrl: BASE
}

describe('jenkinsGetJson credential scope', () => {
  it('follows a hop that stays inside the configured prefix', async () => {
    hops = []
    plainRequests = []
    hopRoute = (url) =>
      url.endsWith('/api/json') ? json({ number: 12 }) : redirect('/jenkins/job/a/2/api/json')
    const { jenkinsGetJson } = await loadRequest()

    const result = await jenkinsGetJson({ ...configured, url: `${BASE}/job/a/1/` })

    expect(result.ok).toBe(true)
    expect(hops.map((hop) => hop.url)).toEqual([
      `${BASE}/job/a/1/`,
      'https://ci.example.com/jenkins/job/a/2/api/json'
    ])
    // The token rides each approved hop, which is why the destination has to be approved first.
    expect(hops.every((hop) => hop.authorization?.startsWith('Basic '))).toBe(true)
  })

  it('refuses a same-origin hop outside the prefix without ever sending the token there', async () => {
    hops = []
    plainRequests = []
    hopRoute = () => redirect('/other-service/steal')
    const { jenkinsGetJson } = await loadRequest()

    const result = await jenkinsGetJson({ ...configured, url: `${BASE}/job/a/1/api/json` })

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.failure.reason).toBe('unauthorized')
    // The load-bearing assertion: one request, to the URL we asked for, and nothing to the hop.
    expect(hops.map((hop) => hop.url)).toEqual([`${BASE}/job/a/1/api/json`])
  })

  it('refuses a request URL outside the prefix before anything is sent', async () => {
    hops = []
    plainRequests = []
    hopRoute = () => json({ number: 12 })
    const { jenkinsGetJson } = await loadRequest()

    // A build URL posted as a commit status by anyone who can push; the path is theirs to choose.
    const result = await jenkinsGetJson({
      ...configured,
      url: 'https://ci.example.com/other-service/job/a/1/api/json'
    })

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.failure.reason).toBe('not-jenkins')
    expect(hops).toEqual([])
    expect(plainRequests).toEqual([])
  })

  it('gives up instead of following an endless chain inside the prefix', async () => {
    hops = []
    plainRequests = []
    hopRoute = (url) => redirect(`${url}x`)
    const { jenkinsGetJson } = await loadRequest()

    const result = await jenkinsGetJson({ ...configured, url: `${BASE}/job/a/1/api/json` })

    expect(result.ok).toBe(false)
    // Hop 0 plus MAX_JENKINS_REDIRECTS followed hops; the sixth Location is refused.
    expect(hops).toHaveLength(6)
  })
})
