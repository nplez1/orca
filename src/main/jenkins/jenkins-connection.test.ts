import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let tempHome = ''

async function loadModules() {
  vi.resetModules()
  vi.doMock('node:os', async () => {
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
  return { connection, store }
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
      '.orca',
      'jenkins-tokens',
      `${Buffer.from(saved.server.id).toString('base64url')}.enc`
    )
    expect(existsSync(tokenPath)).toBe(true)

    expect(connection.removeJenkinsServerById(saved.server.id)).toBe(true)
    expect(connection.listJenkinsServerSummaries()).toEqual([])
    expect(existsSync(tokenPath)).toBe(false)
    expect(store.readJenkinsServerToken(saved.server.id)).toBeNull()
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
