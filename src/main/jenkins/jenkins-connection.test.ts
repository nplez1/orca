import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let tempHome = ''

async function loadModules() {
  vi.resetModules()
  vi.doMock('node:os', async () => {
    // ast-grep-ignore: test-no-in-test-import-actual -- the point of this case is the real homedir, redirected; a stubbed os module would test the stub.
    const actual = await vi.importActual<typeof Os>('node:os')
    return { ...actual, homedir: () => tempHome }
  })
  const { setSecretStore } = await import('../../shared/secret-store')
  setSecretStore({
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value),
    decryptString: (value) => value.toString('utf-8'),
    describeProtectionGap: () => null
  })
  const connection = await import('./jenkins-connection')
  const store = await import('./jenkins-server-store')
  const { JenkinsServerStoreUnreadableError } = store
  return { connection, store, JenkinsServerStoreUnreadableError }
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'orca-jenkins-store-'))
})

afterEach(() => {
  vi.doUnmock('node:os')
})

describe('Jenkins server profiles', () => {
  it('saves a server, keeps its token out of the summary, and reads it back', async () => {
    const { connection, store } = await loadModules()

    const saved = connection.saveJenkinsServerFromArgs({
      label: '  ',
      baseUrl: 'https://ci.example.com/jenkins/',
      username: ' ada ',
      apiToken: ' s3cret '
    })

    expect(saved).toEqual({
      ok: true,
      server: {
        id: expect.any(String),
        label: 'ci.example.com',
        baseUrl: 'https://ci.example.com/jenkins',
        username: 'ada',
        hasToken: true
      }
    })
    const id = saved.ok ? saved.server.id : ''
    expect(store.readJenkinsServerToken(id)).toBe('s3cret')
    expect(connection.listJenkinsServerSummaries()).toEqual([saved.ok ? saved.server : null])
    // The summary is what crosses IPC, so the token must never be part of it.
    expect(JSON.stringify(connection.listJenkinsServerSummaries())).not.toContain('s3cret')
  })

  it('keeps the stored token when an edit omits one', async () => {
    const { connection, store } = await loadModules()
    const saved = connection.saveJenkinsServerFromArgs({
      baseUrl: 'https://ci.example.com',
      label: 'CI',
      username: 'ada',
      apiToken: 'first'
    })
    expect(saved.ok).toBe(true)
    if (!saved.ok) {
      return
    }

    const updated = connection.saveJenkinsServerFromArgs({
      id: saved.server.id,
      baseUrl: 'https://ci.example.com',
      label: 'CI (renamed)',
      username: 'ada'
    })

    expect(updated.ok && updated.server.label).toBe('CI (renamed)')
    expect(store.readJenkinsServerToken(saved.server.id)).toBe('first')
    expect(connection.listJenkinsServerSummaries()).toHaveLength(1)
  })

  it('refuses two profiles for the same URL', async () => {
    const { connection } = await loadModules()
    connection.saveJenkinsServerFromArgs({
      baseUrl: 'https://ci.example.com',
      label: 'CI',
      username: 'ada',
      apiToken: 'token'
    })

    const duplicate = connection.saveJenkinsServerFromArgs({
      // Same server, differently typed: normalization has to catch it.
      baseUrl: 'https://ci.example.com/',
      label: 'CI again',
      username: 'ada',
      apiToken: 'token'
    })

    expect(duplicate).toEqual({ ok: false, error: 'That URL is already used by "CI".' })
  })

  it('rejects a URL that cannot address a server', async () => {
    const { connection } = await loadModules()
    expect(
      connection.saveJenkinsServerFromArgs({
        baseUrl: 'ci.example.com',
        label: '',
        username: '',
        apiToken: 'x'
      })
    ).toEqual({
      ok: false,
      error: 'Enter a valid http or https Jenkins URL.'
    })
  })

  it('removes the profile and its token', async () => {
    const { connection, store } = await loadModules()
    const saved = connection.saveJenkinsServerFromArgs({
      baseUrl: 'https://ci.example.com',
      label: 'CI',
      username: 'ada',
      apiToken: 'token'
    })
    if (!saved.ok) {
      throw new Error('save failed')
    }
    const tokenPath = join(
      tempHome,
      '.orca-np',
      'jenkins-tokens',
      `${Buffer.from(saved.server.id).toString('base64url')}.enc`
    )
    expect(existsSync(tokenPath)).toBe(true)

    expect(connection.removeJenkinsServerById(saved.server.id)).toBe(true)
    expect(connection.listJenkinsServerSummaries()).toEqual([])
    expect(existsSync(tokenPath)).toBe(false)
    expect(store.readJenkinsServerToken(saved.server.id)).toBeNull()
  })

  // The bug this names: a corrupt file read as "no servers", and the next save persisted that emptiness
  // over every profile while their tokens stayed behind in jenkins-tokens/.
  it('refuses to save or remove over a profiles file it cannot read', async () => {
    const { connection, store, JenkinsServerStoreUnreadableError } = await loadModules()
    const saved = connection.saveJenkinsServerFromArgs({
      baseUrl: 'https://ci.example.com',
      label: 'CI',
      username: 'ada',
      apiToken: 'token'
    })
    if (!saved.ok) {
      throw new Error('save failed')
    }
    const profilesPath = join(tempHome, '.orca-np', 'jenkins-servers.json')
    writeFileSync(profilesPath, '{"version":1,"servers":[')

    const save = connection.saveJenkinsServerFromArgs({
      baseUrl: 'https://other.example.com',
      label: 'other',
      username: 'ada',
      apiToken: 'token'
    })
    expect(save.ok).toBe(false)
    expect(save.ok ? '' : save.error).toContain('Could not read the Jenkins servers')
    // Why the file is asserted: the refusal has to leave the bytes that still hold the profiles.
    expect(readFileSync(profilesPath, 'utf-8')).toBe('{"version":1,"servers":[')
    expect(() => store.removeJenkinsServer(saved.server.id)).toThrow(
      JenkinsServerStoreUnreadableError
    )
    expect(store.listJenkinsServers()).toEqual([])
  })

  it('reports an unreadable profiles file to the settings pane instead of an empty list', async () => {
    const { connection, JenkinsServerStoreUnreadableError } = await loadModules()
    mkdirSync(join(tempHome, '.orca-np'), { recursive: true })
    writeFileSync(join(tempHome, '.orca-np', 'jenkins-servers.json'), 'not json')

    expect(() => connection.listJenkinsServerSummaries()).toThrow(JenkinsServerStoreUnreadableError)
  })

  // J5's shape at this store's boundary: an un-imported copy used to look like "nothing configured".
  it('reports a pre-rename copy it could not import', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { connection } = await loadModules()
    mkdirSync(join(tempHome, '.orca'), { recursive: true })
    writeFileSync(join(tempHome, '.orca', 'jenkins-servers.json'), '{"version":1,"servers":[]}')
    // Makes creating the fork's own home impossible, so the copy cannot be made.
    writeFileSync(join(tempHome, '.orca-np'), 'not a directory')

    expect(() => connection.listJenkinsServerSummaries()).toThrow(
      /Could not import the Jenkins servers saved in/
    )
  })
})

describe('findJenkinsServerForUrl', () => {
  it('picks the longest configured prefix, not the first or the origin', async () => {
    const { connection, store } = await loadModules()
    connection.saveJenkinsServerFromArgs({
      baseUrl: 'https://host.example.com',
      label: 'root',
      username: 'ada',
      apiToken: 'root-token'
    })
    const nested = connection.saveJenkinsServerFromArgs({
      baseUrl: 'https://host.example.com/jenkins',
      label: 'prefixed',
      username: 'ada',
      apiToken: 'nested-token'
    })
    if (!nested.ok) {
      throw new Error('save failed')
    }

    expect(
      store.findJenkinsServerForUrl('https://host.example.com/jenkins/job/team/job/repo/12/')?.label
    ).toBe('prefixed')
    expect(store.findJenkinsServerForUrl('https://host.example.com/other/job/12/')?.label).toBe(
      'root'
    )
    expect(store.findJenkinsServerForUrl('https://other.example.com/job/12/')).toBeNull()
    // A sibling path is not under the prefix, however similar the text.
    expect(
      store.findJenkinsServerForUrl('https://host.example.com/jenkins-old/job/12/')?.label
    ).toBe('root')
  })
})
