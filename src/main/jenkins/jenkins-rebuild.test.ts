import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JenkinsSaveServerResult } from '../../shared/jenkins-servers'

const SERVER_URL = 'https://ci.example.com'
const JOB_URL = `${SERVER_URL}/job/team/job/repo/`
const BUILD_URL = `${JOB_URL}12/`
const CHECK_URL = `${BUILD_URL}display/redirect`

let tempHome = ''
let requests: { url: string; init: RequestInit }[] = []
let route: (url: string, init: RequestInit) => Response | Promise<Response> = () =>
  new Response(null, { status: 404 })

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

async function loadModules() {
  vi.resetModules()
  vi.doMock('node:os', async () => {
    const actual = await vi.importActual<typeof Os>('node:os')
    return { ...actual, homedir: () => tempHome }
  })
  vi.doMock('../network/proxy-settings', () => ({
    ensureElectronProxyFromEnvironment: async () => undefined
  }))
  const { setSecretStore } = await import('../../shared/secret-store')
  setSecretStore({
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value),
    decryptString: (value) => value.toString('utf-8'),
    describeProtectionGap: () => null
  })
  const { setMainHttpClient } = await import('../network/http-client')
  setMainHttpClient({
    fetch: async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} })
      return route(String(url), init ?? {})
    },
    proxySession: () => null
  })
  const connection = await import('./jenkins-connection')
  const rebuild = await import('./jenkins-rebuild')
  return { connection, rebuild }
}

function configureServer(connection: {
  saveJenkinsServerFromArgs: (args: {
    label: string
    baseUrl: string
    username: string
    apiToken: string
  }) => JenkinsSaveServerResult
}): void {
  const result = connection.saveJenkinsServerFromArgs({
    label: 'CI',
    baseUrl: SERVER_URL,
    username: 'ada',
    apiToken: 's3cret'
  })
  if (!result.ok) {
    throw new Error('failed to configure the test server')
  }
}

function posts(): { url: string; init: RequestInit }[] {
  return requests.filter((request) => request.init.method === 'POST')
}

/** Jenkins answers a rerun with a 302 back to the job page, which the transport follows. */
function redirectToJob(): Response {
  const response = new Response(null, { status: 200 })
  Object.defineProperty(response, 'url', { value: JOB_URL })
  return response
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'orca-jenkins-rerun-'))
  requests = []
  route = () => new Response(null, { status: 404 })
})

afterEach(() => {
  vi.doUnmock('node:os')
  vi.doUnmock('../network/proxy-settings')
})

describe('rerunJenkinsBuild', () => {
  it('posts to the build’s replay action, authenticated, with the crumb', async () => {
    const { connection, rebuild } = await loadModules()
    configureServer(connection)
    route = (url) => {
      if (url.includes('crumbIssuer')) {
        return json({ crumbRequestField: 'Jenkins-Crumb', crumb: 'abc123' })
      }
      return redirectToJob()
    }

    const result = await rebuild.rerunJenkinsBuild({ url: CHECK_URL })

    expect(result).toEqual({ ok: true, buildNumber: 12 })
    // Why this exact path: `ReplayAction.doRebuild` is the rerun behind Jenkins' and Blue Ocean's
    // own button, and it replays the original script without needing any parameter value.
    expect(posts().map((request) => request.url)).toEqual([`${BUILD_URL}replay/rebuild`])
    expect(posts()[0].init.body).toBeUndefined()
    const headers = new Headers(posts()[0].init.headers)
    expect(headers.get('Jenkins-Crumb')).toBe('abc123')
    expect(headers.get('Authorization')).toBe(
      `Basic ${Buffer.from('ada:s3cret').toString('base64')}`
    )
  })

  it('accepts a rerun that answers with a redirect to the job page', async () => {
    const { connection, rebuild } = await loadModules()
    configureServer(connection)
    route = () => redirectToJob()

    // Why: Jenkins ends a queued rerun with `sendRedirect`, so a redirect is the success path and
    // reading it as ambiguity would tell the user nothing started.
    await expect(rebuild.rerunJenkinsBuild({ url: CHECK_URL })).resolves.toEqual({
      ok: true,
      buildNumber: 12
    })
  })

  it('reports a build with no replay action as not replayable', async () => {
    const { connection, rebuild } = await loadModules()
    configureServer(connection)
    route = (_url, init) =>
      init.method === 'POST' ? new Response(null, { status: 404 }) : json({})

    const result = await rebuild.rerunJenkinsBuild({ url: CHECK_URL })

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    // Why its own reason: a freestyle job has no `ReplayAction`, and "no longer available" would
    // send the user looking for a build that is right there.
    expect(result.reason).toBe('not-replayable')
    expect(posts()).toHaveLength(1)
  })

  it('does not retry when Jenkins refuses the rerun', async () => {
    const { connection, rebuild } = await loadModules()
    configureServer(connection)
    route = (_url, init) =>
      init.method === 'POST' ? new Response(null, { status: 403 }) : json({})

    const result = await rebuild.rerunJenkinsBuild({ url: CHECK_URL })

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.reason).toBe('forbidden')
    expect(posts()).toHaveLength(1)
  })

  it('reports a redirect that landed on a failure as unconfirmed', async () => {
    const { connection, rebuild } = await loadModules()
    configureServer(connection)
    route = (_url, init) => {
      if (init.method !== 'POST') {
        return json({})
      }
      const response = new Response(null, { status: 404 })
      Object.defineProperty(response, 'url', { value: `${JOB_URL}somewhere` })
      return response
    }

    const result = await rebuild.rerunJenkinsBuild({ url: CHECK_URL })

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.reason).toBe('unconfirmed')
  })

  it('refuses without sending anything when no server is configured for the URL', async () => {
    const { rebuild } = await loadModules()

    const result = await rebuild.rerunJenkinsBuild({ url: CHECK_URL })

    expect(result).toEqual({
      ok: false,
      reason: 'not-configured',
      serverUrl: SERVER_URL,
      message: null
    })
    expect(requests).toHaveLength(0)
  })

  it('refuses a link that is not a Jenkins build', async () => {
    const { rebuild } = await loadModules()

    const result = await rebuild.rerunJenkinsBuild({ url: 'https://example.com/not-jenkins' })

    expect(result).toEqual({ ok: false, reason: 'not-jenkins', serverUrl: null, message: null })
    expect(requests).toHaveLength(0)
  })

  it('distinguishes a Jenkins link that names no build from a non-Jenkins one', async () => {
    const { connection, rebuild } = await loadModules()
    configureServer(connection)

    // A GitHub Actions job URL parses as a job named `456` with no build, and a job-level Jenkins
    // link names no build either — neither has a build to rerun.
    for (const url of [JOB_URL, 'https://github.com/o/r/actions/runs/1/job/456']) {
      const result = await rebuild.rerunJenkinsBuild({ url })
      expect(result.ok).toBe(false)
      if (result.ok) {
        return
      }
      expect(result.reason).toBe('no-build')
    }
    expect(requests).toHaveLength(0)
  })
})
