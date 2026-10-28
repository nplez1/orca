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

function buildBody(actions: unknown[] = []): unknown {
  return { number: 12, building: false, result: 'FAILURE', actions }
}

const parameterAction = {
  _class: 'hudson.model.ParametersAction',
  parameters: [
    { _class: 'hudson.model.StringParameterValue', name: 'BRANCH', value: 'main' },
    { _class: 'hudson.model.BooleanParameterValue', name: 'DEPLOY', value: true },
    // Why no value: Jenkins does not export a password parameter's value, and sending `''` would
    // blank the job's default rather than leave it alone.
    { _class: 'hudson.model.PasswordParameterValue', name: 'DEPLOY_TOKEN' }
  ]
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

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'orca-jenkins-rebuild-'))
  requests = []
  route = () => new Response(null, { status: 404 })
})

afterEach(() => {
  vi.doUnmock('node:os')
  vi.doUnmock('../network/proxy-settings')
})

describe('rebuildJenkinsBuild', () => {
  it('starts a new build with the parameters read in the main process', async () => {
    const { connection, rebuild } = await loadModules()
    configureServer(connection)
    route = (url, init) => {
      if (url.includes('crumbIssuer')) {
        return json({ crumbRequestField: 'Jenkins-Crumb', crumb: 'abc123' })
      }
      return init.method === 'POST'
        ? new Response(null, { status: 201 })
        : json(buildBody([parameterAction]))
    }

    const result = await rebuild.rebuildJenkinsBuild({ url: CHECK_URL })

    expect(result).toEqual({
      ok: true,
      mode: 'parameters',
      buildNumber: 12,
      omittedParameters: 1
    })
    expect(posts().map((request) => request.url)).toEqual([`${JOB_URL}buildWithParameters`])
    const body = String(posts()[0].init.body)
    expect(body).toContain('BRANCH=main')
    // Why "true": `String(true)` is what Jenkins parses back, while an empty value would be false.
    expect(body).toContain('DEPLOY=true')
    // Why absent: an explicit empty value would override the job's default with a blank secret.
    expect(body).not.toContain('DEPLOY_TOKEN')
  })

  it('sends the crumb and the saved credentials, and never follows a redirect', async () => {
    const { connection, rebuild } = await loadModules()
    configureServer(connection)
    route = (url, init) => {
      if (url.includes('crumbIssuer')) {
        return json({ crumbRequestField: 'Jenkins-Crumb', crumb: 'abc123' })
      }
      return init.method === 'POST'
        ? new Response(null, { status: 201 })
        : json(buildBody([parameterAction]))
    }

    await rebuild.rebuildJenkinsBuild({ url: CHECK_URL })

    const headers = new Headers(posts()[0].init.headers)
    expect(headers.get('Jenkins-Crumb')).toBe('abc123')
    expect(headers.get('Authorization')).toBe(
      `Basic ${Buffer.from('ada:s3cret').toString('base64')}`
    )
    // Why assert the mode: following a redirect would re-issue the write as a GET and judge it by
    // whatever page it landed on.
    expect(posts()[0].init.redirect).toBe('manual')
  })

  it('uses the parameterless endpoint for a job that takes none', async () => {
    const { connection, rebuild } = await loadModules()
    configureServer(connection)
    route = (_url, init) =>
      init.method === 'POST' ? new Response(null, { status: 201 }) : json(buildBody())

    const result = await rebuild.rebuildJenkinsBuild({ url: CHECK_URL })

    expect(result).toEqual({
      ok: true,
      mode: 'build',
      buildNumber: 12,
      omittedParameters: 0
    })
    expect(posts().map((request) => request.url)).toEqual([`${JOB_URL}build`])
    expect(posts()[0].init.body).toBeUndefined()
  })

  it('reports a redirect as unconfirmed rather than as a failure or a success', async () => {
    const { connection, rebuild } = await loadModules()
    configureServer(connection)
    route = (_url, init) =>
      init.method === 'POST'
        ? new Response(null, { status: 302, headers: { location: `${JOB_URL}12/` } })
        : json(buildBody([parameterAction]))

    const result = await rebuild.rebuildJenkinsBuild({ url: CHECK_URL })

    // Why: a 302 may mean the build was queued, so calling it a failure would invite a retry that
    // starts a second one, and calling it a success would claim a build that never started.
    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.reason).toBe('unconfirmed')
    expect(posts()).toHaveLength(1)
  })

  it('does not retry on another endpoint when Jenkins refuses the write', async () => {
    const { connection, rebuild } = await loadModules()
    configureServer(connection)
    route = (_url, init) =>
      init.method === 'POST'
        ? new Response(null, { status: 403 })
        : json(buildBody([parameterAction]))

    const result = await rebuild.rebuildJenkinsBuild({ url: CHECK_URL })

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.reason).toBe('forbidden')
    expect(posts()).toHaveLength(1)
  })

  it('refuses without sending anything when no server is configured for the URL', async () => {
    const { rebuild } = await loadModules()

    const result = await rebuild.rebuildJenkinsBuild({ url: CHECK_URL })

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

    const result = await rebuild.rebuildJenkinsBuild({ url: 'https://example.com/not-jenkins' })

    expect(result).toEqual({ ok: false, reason: 'not-jenkins', serverUrl: null, message: null })
    expect(requests).toHaveLength(0)
  })

  it('distinguishes a Jenkins link that names no build from a non-Jenkins one', async () => {
    const { connection, rebuild } = await loadModules()
    configureServer(connection)

    // A GitHub Actions job URL parses as a job named `456` with no build, and a job-level Jenkins
    // link names no build either — neither has a build to start again.
    for (const url of [JOB_URL, 'https://github.com/o/r/actions/runs/1/job/456']) {
      const result = await rebuild.rebuildJenkinsBuild({ url })
      expect(result.ok).toBe(false)
      if (result.ok) {
        return
      }
      expect(result.reason).toBe('no-build')
    }
    expect(requests).toHaveLength(0)
  })

  it('reports a broken payload rather than guessing a build number', async () => {
    const { connection, rebuild } = await loadModules()
    configureServer(connection)
    route = () => json({ hello: 'world' })

    const result = await rebuild.rebuildJenkinsBuild({ url: CHECK_URL })

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.reason).toBe('error')
    expect(posts()).toHaveLength(0)
  })
})
