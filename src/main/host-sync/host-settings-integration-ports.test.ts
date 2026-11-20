import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraSite, JiraSiteSelection } from '../../shared/jira/jira-types'
import type { JenkinsServerProfile } from '../../shared/jenkins-servers'
import type { SecretAtRestProtection } from '../../shared/secure-storage/secret-at-rest-protection'
import type { JiraSiteFile } from '../jira/site-credential-store'
import type * as JiraStoreModule from '../jira/site-credential-store'
import type * as JenkinsStoreModule from '../jenkins/jenkins-server-store'

const jiraSite: JiraSite = {
  id: 'site-1',
  siteUrl: 'https://acme.atlassian.net',
  email: 'ada@acme.test',
  displayName: 'Acme',
  accountId: 'acct-1',
  authType: 'cloud'
}

const jenkinsServer: JenkinsServerProfile = {
  id: 'ci-1',
  label: 'CI',
  baseUrl: 'https://ci.acme.test',
  username: 'ada'
}

/** The receiving host's credential stores, with the shapes their modules actually expose. */
const jiraState = vi.hoisted(
  (): {
    sites: JiraSite[]
    activeSiteId: string | null
    selectedSiteId: JiraSiteSelection | null
    tokens: Map<string, string>
    protections: Map<string, SecretAtRestProtection>
    /** Ids whose token file is there but cannot be read right now. */
    unreadable: Set<string>
    written: JiraSiteFile[]
    deleted: string[]
  } => ({
    sites: [],
    activeSiteId: null,
    selectedSiteId: null,
    tokens: new Map(),
    protections: new Map(),
    unreadable: new Set(),
    written: [],
    deleted: []
  })
)

const jenkinsState = vi.hoisted(
  (): {
    servers: JenkinsServerProfile[]
    tokens: Map<string, string>
    protections: Map<string, SecretAtRestProtection>
    unreadable: Set<string>
    saved: { server: JenkinsServerProfile; token: string | null }[]
    removed: string[]
  } => ({
    servers: [],
    tokens: new Map(),
    protections: new Map(),
    unreadable: new Set(),
    saved: [],
    removed: []
  })
)

vi.mock('../jira/site-credential-store', async () => {
  const actual = await vi.importActual<typeof JiraStoreModule>('../jira/site-credential-store')
  return {
    ...actual,
    // Why async: the port awaits this store, and a sync stand-in would keep a missing await passing.
    getSiteFile: async (): Promise<JiraSiteFile> => ({
      version: 1,
      activeSiteId: jiraState.activeSiteId,
      selectedSiteId: jiraState.selectedSiteId,
      sites: jiraState.sites
    }),
    writeSiteFile: async (file: JiraSiteFile): Promise<void> => {
      jiraState.written.push(file)
      jiraState.sites = file.sites
      jiraState.activeSiteId = file.activeSiteId
    },
    hasStoredToken: async (siteId: string): Promise<boolean> => jiraState.tokens.has(siteId),
    readToken: async (siteId: string): Promise<string | null> =>
      jiraState.unreadable.has(siteId) ? null : (jiraState.tokens.get(siteId) ?? null),
    saveToken: async (siteId: string, token: string): Promise<void> => {
      jiraState.tokens.set(siteId, token)
      jiraState.protections.set(siteId, 'sealed')
    },
    deleteToken: async (siteId: string): Promise<void> => {
      jiraState.tokens.delete(siteId)
      jiraState.protections.delete(siteId)
      jiraState.deleted.push(siteId)
    },
    getSiteTokenProtection: async (siteId: string): Promise<SecretAtRestProtection | null> =>
      jiraState.protections.get(siteId) ?? null
  }
})

vi.mock('../jenkins/jenkins-server-store', async () => {
  const actual = await vi.importActual<typeof JenkinsStoreModule>('../jenkins/jenkins-server-store')
  return {
    ...actual,
    listJenkinsServers: (): JenkinsServerProfile[] => jenkinsState.servers,
    saveJenkinsServer: async (
      server: JenkinsServerProfile,
      token: string | null
    ): Promise<void> => {
      jenkinsState.saved.push({ server, token })
      jenkinsState.servers = [
        ...jenkinsState.servers.filter((candidate) => candidate.id !== server.id),
        server
      ]
      if (token !== null) {
        jenkinsState.tokens.set(server.id, token)
        jenkinsState.protections.set(server.id, 'sealed')
      }
    },
    removeJenkinsServer: (serverId: string): boolean => {
      jenkinsState.removed.push(serverId)
      jenkinsState.servers = jenkinsState.servers.filter((candidate) => candidate.id !== serverId)
      jenkinsState.tokens.delete(serverId)
      jenkinsState.protections.delete(serverId)
      return true
    },
    readJenkinsServerToken: (serverId: string): string | null =>
      jenkinsState.unreadable.has(serverId) ? null : (jenkinsState.tokens.get(serverId) ?? null),
    hasJenkinsServerToken: async (serverId: string): Promise<boolean> =>
      jenkinsState.tokens.has(serverId),
    getJenkinsServerTokenProtection: async (
      serverId: string
    ): Promise<SecretAtRestProtection | null> => jenkinsState.protections.get(serverId) ?? null
  }
})

const { createHostSettingsJiraPort } = await import('./host-settings-jira-port')
const { createHostSettingsJenkinsPort } = await import('./host-settings-jenkins-port')

beforeEach(() => {
  jiraState.sites = []
  jiraState.activeSiteId = null
  jiraState.selectedSiteId = null
  jiraState.tokens = new Map()
  jiraState.protections = new Map()
  jiraState.unreadable = new Set()
  jiraState.written = []
  jiraState.deleted = []
  jenkinsState.servers = []
  jenkinsState.tokens = new Map()
  jenkinsState.protections = new Map()
  jenkinsState.unreadable = new Set()
  jenkinsState.saved = []
  jenkinsState.removed = []
})

describe('the Jira credential port', () => {
  it('exports one credential per site, carrying the site with its token', async () => {
    jiraState.sites = [jiraSite]
    jiraState.tokens.set('site-1', 'jira-token')
    jiraState.protections.set('site-1', 'sealed')

    const [credential] = await createHostSettingsJiraPort().list()

    expect(credential).toMatchObject({
      id: 'jira:site-1',
      kind: 'jira',
      protection: 'sealed',
      onlyIfEmpty: false
    })
    expect(JSON.parse(credential.payload)).toEqual({ site: jiraSite, token: 'jira-token' })
  })

  it('skips a site whose token this host cannot read, without dropping the others', async () => {
    jiraState.sites = [jiraSite, { ...jiraSite, id: 'site-2' }]
    jiraState.tokens.set('site-2', 'readable')
    jiraState.protections.set('site-1', 'sealed')
    jiraState.protections.set('site-2', 'sealed')

    const credentials = await createHostSettingsJiraPort().list()

    expect(credentials.map((credential) => credential.id)).toEqual(['jira:site-2'])
  })

  it('adds a replicated site without moving which site this host is looking at', async () => {
    jiraState.activeSiteId = 'site-local'
    jiraState.sites = [{ ...jiraSite, id: 'site-local' }]

    await createHostSettingsJiraPort().apply({
      id: 'jira:site-1',
      kind: 'jira',
      label: 'Jira Acme',
      protection: 'sealed',
      onlyIfEmpty: false,
      payload: JSON.stringify({ site: jiraSite, token: 'jira-token' })
    })

    expect(jiraState.tokens.get('site-1')).toBe('jira-token')
    expect(jiraState.activeSiteId).toBe('site-local')
    expect(jiraState.sites.map((site) => site.id).sort()).toEqual(['site-1', 'site-local'])
  })

  it('refuses a malformed payload rather than writing half a site', async () => {
    await expect(
      createHostSettingsJiraPort().apply({
        id: 'jira:site-1',
        kind: 'jira',
        label: 'Jira Acme',
        protection: 'sealed',
        onlyIfEmpty: false,
        payload: '{"site":{"id":42}}'
      })
    ).rejects.toThrow('malformed')
    expect(jiraState.tokens.size).toBe(0)
  })

  it('revokes one site without touching another', async () => {
    jiraState.sites = [jiraSite, { ...jiraSite, id: 'site-2' }]
    jiraState.tokens.set('site-1', 'a')
    jiraState.tokens.set('site-2', 'b')
    jiraState.protections.set('site-1', 'sealed')
    jiraState.protections.set('site-2', 'sealed')

    await createHostSettingsJiraPort().remove('jira:site-1')

    expect(jiraState.deleted).toEqual(['site-1'])
    expect(jiraState.tokens.has('site-2')).toBe(true)
    expect(jiraState.sites.map((site) => site.id)).toEqual(['site-2'])
  })

  it('ignores a credential id that belongs to another kind', async () => {
    jiraState.sites = [jiraSite]

    await createHostSettingsJiraPort().remove('jenkins:ci-1')

    expect(jiraState.deleted).toEqual([])
    expect(jiraState.sites).toHaveLength(1)
  })

  // Why: a token file that exists but cannot be read right now (EBUSY under a Windows antivirus scan,
  // EACCES) is not a deleted site. Reporting it as absent puts it in the removal list, and every host
  // then deletes a working token because one machine's read failed.
  it('reports a site whose token cannot be read as unreadable rather than absent', async () => {
    jiraState.sites = [jiraSite]
    jiraState.tokens.set('site-1', 'jira-token')
    jiraState.unreadable.add('site-1')

    const port = createHostSettingsJiraPort()

    expect(await port.unreadableIds()).toEqual(['jira:site-1'])
    expect(await port.list()).toEqual([])
    // Why not null: null claims this host holds nothing, which is what makes a removal look verified.
    expect(await port.protectionOf('jira:site-1')).toBe('plaintext')
  })

  // Why this case: the token cache can answer while a fresh classification read fails (antivirus lock on
  // Windows). If `list()` judged by the classification and `unreadableIds()` by the token, the site would
  // be in neither — and the sender would then name it as a removal.
  it('still exports a site whose token reads when its file cannot be classified', async () => {
    jiraState.sites = [jiraSite]
    jiraState.tokens.set('site-1', 'jira-token')

    const port = createHostSettingsJiraPort()

    expect(await port.unreadableIds()).toEqual([])
    expect(await port.list()).toHaveLength(1)
    expect((await port.list())[0]).toMatchObject({ protection: 'sealed' })
    // Why the other direction here: overstating protection is what would record a plaintext copy as sealed.
    expect(await port.protectionOf('jira:site-1')).toBe('plaintext')
  })

  it('does not name a site it holds no token file for', async () => {
    jiraState.sites = [jiraSite]

    expect(await createHostSettingsJiraPort().unreadableIds()).toEqual([])
  })
})

describe('the Jenkins credential port', () => {
  it('exports one credential per server, carrying the profile with its token', async () => {
    jenkinsState.servers = [jenkinsServer]
    jenkinsState.tokens.set('ci-1', 'jenkins-token')
    jenkinsState.protections.set('ci-1', 'sealed')

    const [credential] = await createHostSettingsJenkinsPort().list()

    expect(credential).toMatchObject({ id: 'jenkins:ci-1', kind: 'jenkins', protection: 'sealed' })
    expect(JSON.parse(credential.payload)).toEqual({
      server: jenkinsServer,
      token: 'jenkins-token'
    })
  })

  it('skips a server with no token on this host', async () => {
    jenkinsState.servers = [jenkinsServer]

    expect(await createHostSettingsJenkinsPort().list()).toEqual([])
  })

  it('writes the profile and its token together on apply', async () => {
    await createHostSettingsJenkinsPort().apply({
      id: 'jenkins:ci-1',
      kind: 'jenkins',
      label: 'Jenkins CI',
      protection: 'sealed',
      onlyIfEmpty: false,
      payload: JSON.stringify({ server: jenkinsServer, token: 'jenkins-token' })
    })

    expect(jenkinsState.saved).toEqual([{ server: jenkinsServer, token: 'jenkins-token' }])
  })

  it('normalizes the server URL out of the payload rather than trusting it', async () => {
    await createHostSettingsJenkinsPort().apply({
      id: 'jenkins:ci-1',
      kind: 'jenkins',
      label: 'Jenkins CI',
      protection: 'sealed',
      onlyIfEmpty: false,
      payload: JSON.stringify({
        server: { ...jenkinsServer, baseUrl: 'https://ci.acme.test/jenkins/' },
        token: 'jenkins-token'
      })
    })

    expect(jenkinsState.saved[0]?.server.baseUrl).toBe('https://ci.acme.test/jenkins')
  })

  it('refuses a payload whose server has no usable URL', async () => {
    await expect(
      createHostSettingsJenkinsPort().apply({
        id: 'jenkins:ci-1',
        kind: 'jenkins',
        label: 'Jenkins CI',
        protection: 'sealed',
        onlyIfEmpty: false,
        payload: JSON.stringify({ server: { ...jenkinsServer, baseUrl: 'not a url' }, token: 'x' })
      })
    ).rejects.toThrow('malformed')
  })

  it('reports a server as unheld once it is revoked', async () => {
    const port = createHostSettingsJenkinsPort()
    jenkinsState.servers = [jenkinsServer]
    jenkinsState.tokens.set('ci-1', 'jenkins-token')
    jenkinsState.protections.set('ci-1', 'sealed')

    port.remove('jenkins:ci-1')

    expect(jenkinsState.removed).toEqual(['ci-1'])
    expect(await port.protectionOf('jenkins:ci-1')).toBeNull()
  })

  it('reports a server whose token cannot be read as unreadable rather than absent', async () => {
    jenkinsState.servers = [jenkinsServer]
    jenkinsState.tokens.set('ci-1', 'jenkins-token')
    jenkinsState.unreadable.add('ci-1')

    const port = createHostSettingsJenkinsPort()

    expect(await port.unreadableIds()).toEqual(['jenkins:ci-1'])
    expect(await port.list()).toEqual([])
    expect(await port.protectionOf('jenkins:ci-1')).toBe('plaintext')
  })

  it('still exports a server whose token reads when its file cannot be classified', async () => {
    jenkinsState.servers = [jenkinsServer]
    // No protection recorded: the classification read failed while the token itself reads fine.
    jenkinsState.tokens.set('ci-1', 'jenkins-token')

    const port = createHostSettingsJenkinsPort()

    expect(await port.unreadableIds()).toEqual([])
    expect(await port.list()).toHaveLength(1)
    expect((await port.list())[0]).toMatchObject({ protection: 'sealed' })
    expect(await port.protectionOf('jenkins:ci-1')).toBe('plaintext')
  })
})
