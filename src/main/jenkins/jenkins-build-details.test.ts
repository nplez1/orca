import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PRCheckDetail } from '../../shared/github/check-types'
import type { JenkinsSaveServerResult } from '../../shared/jenkins-servers'

const BUILD_URL = 'https://ci.example.com/job/team/job/repo/12/'
const check: Pick<PRCheckDetail, 'name' | 'status' | 'conclusion'> & { url: string } = {
  name: 'continuous-integration/jenkins/pr-merge',
  status: 'completed',
  conclusion: 'failure',
  url: `${BUILD_URL}display/redirect`
}

let tempHome = ''
let requests: { url: string; init: RequestInit }[] = []
let route: (url: string) => Response | Promise<Response> = () => new Response(null, { status: 404 })

function json(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers }
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
      return route(String(url))
    },
    proxySession: () => null
  })
  const connection = await import('./jenkins-connection')
  const details = await import('./jenkins-build-details')
  const request = await import('./jenkins-request')
  return {
    connection,
    details,
    isResponseBeyondCredentialScope: request.isResponseBeyondCredentialScope
  }
}

function configureServer(
  connection: {
    saveJenkinsServerFromArgs: (args: {
      label: string
      baseUrl: string
      username: string
      apiToken: string
    }) => JenkinsSaveServerResult
  },
  baseUrl = 'https://ci.example.com'
): void {
  const result = connection.saveJenkinsServerFromArgs({
    label: 'CI',
    baseUrl,
    username: 'ada',
    apiToken: 's3cret'
  })
  if (!result.ok) {
    throw new Error('failed to configure the test server')
  }
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'orca-jenkins-details-'))
  requests = []
  route = () => new Response(null, { status: 404 })
})

afterEach(() => {
  vi.doUnmock('node:os')
  vi.doUnmock('../network/proxy-settings')
})

describe('getJenkinsBuildDetails', () => {
  it('reads a build and its stages, authenticating with the stored token', async () => {
    const { connection, details } = await loadModules()
    configureServer(connection)
    route = (url) =>
      url.includes('wfapi/describe')
        ? json({ startTimeMillis: 1_700_000_000_000, stages: [{ name: 'Test', status: 'FAILED' }] })
        : json({ number: 12, building: false, result: 'FAILURE', displayName: '#12' })

    const result = await details.getJenkinsBuildDetails({ url: check.url, check })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.details.jobs[0].steps.map((step) => [step.name, step.conclusion])).toEqual([
      ['Test', 'failure']
    ])
    expect(result.details.build?.number).toBe('12')
    expect(requests[0].url.startsWith(`${BUILD_URL}api/json?tree=`)).toBe(true)
    expect(requests[1].url).toBe(`${BUILD_URL}wfapi/describe`)
    const headers = new Headers(requests[0].init.headers)
    expect(headers.get('Authorization')).toBe(
      `Basic ${Buffer.from('ada:s3cret').toString('base64')}`
    )
    expect(headers.get('Accept')).toBe('application/json')
  })

  it('asks for only the build fields it maps', async () => {
    const { connection, details } = await loadModules()
    configureServer(connection)
    route = (url) =>
      url.includes('wfapi') ? new Response(null, { status: 404 }) : json(buildBody())

    await details.getJenkinsBuildDetails({ url: check.url, check })

    const tree = new URL(requests[0].url).searchParams.get('tree') ?? ''
    expect(tree).toContain('changeSets[items[commitId,msg,comment,author[fullName]]]')
    expect(tree).toContain(
      'actions[_class,causes[_class,shortDescription],parameters[_class,name,value]]'
    )
  })

  it('still renders the build when the stage endpoint is unavailable (freestyle)', async () => {
    const { connection, details } = await loadModules()
    configureServer(connection)
    route = (url) =>
      url.includes('wfapi') ? new Response(null, { status: 404 }) : json(buildBody())

    const result = await details.getJenkinsBuildDetails({ url: check.url, check })

    expect(result.ok).toBe(true)
    expect(result.ok && result.details.jobs[0].steps).toEqual([])
    expect(result.ok && result.details.jobs[0].stepRendering).toBeUndefined()
  })

  it('falls through to the caller when the URL is not Jenkins at all', async () => {
    const { details } = await loadModules()
    route = () => new Response(null, { status: 404 })

    await expect(
      details.getJenkinsBuildDetails({
        url: 'https://careers.example.com/job/apply/2024',
        check
      })
    ).resolves.toMatchObject({ ok: false, reason: 'not-jenkins' })
  })

  it('tells the user to configure a server only when Jenkins asked for credentials', async () => {
    const { details } = await loadModules()
    route = () => new Response(null, { status: 401 })

    const result = await details.getJenkinsBuildDetails({ url: check.url, check })

    expect(result).toMatchObject({
      ok: false,
      reason: 'not-configured',
      serverUrl: 'https://ci.example.com'
    })
  })

  it('treats a Jenkins-identified 404 as a pruned build rather than a non-Jenkins URL', async () => {
    const { details } = await loadModules()
    // No configured server: the header is the only evidence available.
    route = () => new Response(null, { status: 404, headers: { 'x-jenkins': '2.452.1' } })

    const result = await details.getJenkinsBuildDetails({ url: check.url, check })

    expect(result).toMatchObject({ ok: false, reason: 'not-found' })
  })

  it('calls a configured server authoritative on 404', async () => {
    const { connection, details } = await loadModules()
    configureServer(connection)
    route = () => new Response(null, { status: 404 })

    await expect(details.getJenkinsBuildDetails({ url: check.url, check })).resolves.toMatchObject({
      ok: false,
      reason: 'not-found'
    })
  })

  it('reads a login page as an auth problem for a configured server', async () => {
    const { connection, details } = await loadModules()
    configureServer(connection)
    route = () =>
      new Response('<html>Sign in</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' }
      })

    await expect(details.getJenkinsBuildDetails({ url: check.url, check })).resolves.toMatchObject({
      ok: false,
      reason: 'unauthorized'
    })
  })

  it('refuses a same-origin redirect that leaves the configured server path', async () => {
    const { connection, details } = await loadModules()
    // A path-prefixed server is the case where a same-origin hop can leave the credential's scope.
    configureServer(connection, 'https://ci.example.com/jenkins')
    const prefixedBuildUrl = 'https://ci.example.com/jenkins/job/team/job/repo/12/'
    const respondWithUrl = (url: string): Response => {
      const response = json(buildBody())
      Object.defineProperty(response, 'url', { value: url })
      return response
    }

    // A permalink redirect that stays under the prefix is the case we must keep following.
    route = () => respondWithUrl(`${prefixedBuildUrl}api/json`)
    await expect(
      details.getJenkinsBuildDetails({ url: prefixedBuildUrl, check })
    ).resolves.toMatchObject({ ok: true })

    // Same origin, so the transport keeps the Authorization header; the prefix is the boundary.
    route = () => respondWithUrl('https://ci.example.com/other-service/steal')
    await expect(
      details.getJenkinsBuildDetails({ url: prefixedBuildUrl, check })
    ).resolves.toMatchObject({ ok: false, reason: 'unauthorized' })
  })

  it('stops reading a response larger than the client will hold', async () => {
    const { connection, details } = await loadModules()
    configureServer(connection)
    route = () =>
      new Response(`{"padding":"${'x'.repeat(9 * 1024 * 1024)}"}`, {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })

    await expect(details.getJenkinsBuildDetails({ url: check.url, check })).resolves.toMatchObject({
      ok: false,
      reason: 'error'
    })
  })

  it('refuses a response that came from an origin we did not ask', async () => {
    const { connection, details } = await loadModules()
    configureServer(connection)
    route = () => {
      const response = new Response('<html>Sign in</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' }
      })
      // A cross-origin redirect leaves response.url pointing at the origin that answered.
      Object.defineProperty(response, 'url', { value: 'https://sso.example.com/login' })
      return response
    }

    await expect(details.getJenkinsBuildDetails({ url: check.url, check })).resolves.toMatchObject({
      ok: false,
      reason: 'unauthorized'
    })
  })

  it('treats unparseable JSON from a configured server as a Jenkins failure, not a foreign URL', async () => {
    const { connection, details } = await loadModules()
    configureServer(connection)
    route = () =>
      new Response('{"number": 12,', {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })

    await expect(details.getJenkinsBuildDetails({ url: check.url, check })).resolves.toMatchObject({
      ok: false,
      reason: 'error'
    })
  })

  it('reports a transport failure instead of an empty pane', async () => {
    const { connection, details } = await loadModules()
    configureServer(connection)
    route = () => {
      throw new Error('net::ERR_CERT_AUTHORITY_INVALID')
    }

    const result = await details.getJenkinsBuildDetails({ url: check.url, check })

    expect(result).toMatchObject({
      ok: false,
      reason: 'unreachable',
      message: 'net::ERR_CERT_AUTHORITY_INVALID'
    })
  })

  it('ignores JSON that is not a build when the host is unconfigured', async () => {
    const { details } = await loadModules()
    route = () => json({ open: true, role: 'engineer' })

    await expect(
      details.getJenkinsBuildDetails({ url: 'https://careers.example.com/job/apply/2024', check })
    ).resolves.toMatchObject({ ok: false, reason: 'not-jenkins' })
  })

  it('reads a public build with no configured server', async () => {
    const { details } = await loadModules()
    route = (url) =>
      url.includes('wfapi') ? new Response(null, { status: 404 }) : json(buildBody())

    const result = await details.getJenkinsBuildDetails({ url: check.url, check })

    expect(result.ok).toBe(true)
    expect(new Headers(requests[0].init.headers).get('Authorization')).toBeNull()
  })
})

function buildBody(): Record<string, unknown> {
  return { number: 12, building: false, result: 'FAILURE', displayName: '#12' }
}

describe('isResponseBeyondCredentialScope', () => {
  const requestUrl = 'https://host.example.com/jenkins/job/a/1/api/json'

  it('bounds a configured server by its configured prefix, not by its origin', async () => {
    const { isResponseBeyondCredentialScope } = await loadModules()
    const base = 'https://host.example.com/jenkins'
    const scope = (responseUrl: string): boolean =>
      isResponseBeyondCredentialScope({ requestUrl, responseUrl, serverBaseUrl: base })

    // A build permalink redirects within the prefix, which is the case we must keep following.
    expect(scope('https://host.example.com/jenkins/job/a/2/api/json')).toBe(false)
    // Why this is the one that matters: same origin, so the transport keeps the Authorization
    // header, but the response is no longer from the server we configured.
    expect(scope('https://host.example.com/other-service/steal')).toBe(true)
    expect(scope('https://sso.example.com/login')).toBe(true)
    // A synthetic Response carries an empty url, which must not read as a redirect.
    expect(scope('')).toBe(false)
  })

  it('falls back to the origin when no server is configured', async () => {
    const { isResponseBeyondCredentialScope } = await loadModules()
    const scope = (responseUrl: string): boolean =>
      isResponseBeyondCredentialScope({ requestUrl, responseUrl, serverBaseUrl: null })

    expect(scope('https://host.example.com/jenkins/job/a/2/api/json')).toBe(false)
    expect(scope('https://sso.example.com/login')).toBe(true)
    expect(scope('http://host.example.com/jenkins/job/a/1/api/json')).toBe(true)
    expect(scope('not a url')).toBe(false)
  })
})

describe('probeJenkinsServer', () => {
  it('reports the version Jenkins advertises', async () => {
    const { connection } = await loadModules()
    route = () => json({ _class: 'hudson.model.Hudson' }, { 'x-jenkins': '2.452.1' })

    await expect(
      connection.probeJenkinsServer({
        baseUrl: 'https://ci.example.com/',
        username: 'ada',
        apiToken: 's3cret'
      })
    ).resolves.toEqual({ ok: true, version: '2.452.1' })
    expect(requests[0].url).toBe('https://ci.example.com/api/json')
  })

  it('rejects a server that is not Jenkins', async () => {
    const { connection } = await loadModules()
    route = () => json({ hello: 'world' })

    await expect(
      connection.probeJenkinsServer({
        baseUrl: 'https://example.com',
        username: '',
        apiToken: null
      })
    ).resolves.toEqual({
      ok: false,
      error: 'https://example.com answered, but it does not look like Jenkins.'
    })
  })

  it('explains a rejected credential', async () => {
    const { connection } = await loadModules()
    route = () => new Response(null, { status: 401 })

    await expect(
      connection.probeJenkinsServer({
        baseUrl: 'https://ci.example.com',
        username: 'ada',
        apiToken: 'bad'
      })
    ).resolves.toEqual({ ok: false, error: 'Jenkins rejected those credentials.' })
  })
})
