import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraSite, JiraSiteSelection } from '../../shared/jira-types'
import type { JenkinsServerProfile } from '../../shared/jenkins-servers'
import type { SecretAtRestProtection } from '../../shared/secret-at-rest-protection'
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
    written: JiraSiteFile[]
    deleted: string[]
  } => ({
    sites: [],
    activeSiteId: null,
    selectedSiteId: null,
    tokens: new Map(),
    protections: new Map(),
    written: [],
    deleted: []
  })
)

const jenkinsState = vi.hoisted(
  (): {
    servers: JenkinsServerProfile[]
    tokens: Map<string, string>
    protections: Map<string, SecretAtRestProtection>
    saved: { server: JenkinsServerProfile; token: string | null }[]
    removed: string[]
  } => ({ servers: [], tokens: new Map(), protections: new Map(), saved: [], removed: [] })
)

vi.mock('../jira/site-credential-store', async () => {
  const actual = await vi.importActual<typeof JiraStoreModule>('../jira/site-credential-store')
  return {
    ...actual,
    getSiteFile: (): JiraSiteFile => ({
      version: 1,
      activeSiteId: jiraState.activeSiteId,
      selectedSiteId: jiraState.selectedSiteId,
      sites: jiraState.sites
    }),
    writeSiteFile: (file: JiraSiteFile): void => {
      jiraState.written.push(file)
      jiraState.sites = file.sites
      jiraState.activeSiteId = file.activeSiteId
    },
    hasStoredToken: (siteId: string): boolean => jiraState.tokens.has(siteId),
    readToken: (siteId: string): string | null => jiraState.tokens.get(siteId) ?? null,
    saveToken: (siteId: string, token: string): void => {
      jiraState.tokens.set(siteId, token)
      jiraState.protections.set(siteId, 'sealed')
    },
    deleteToken: (siteId: string): void => {
      jiraState.tokens.delete(siteId)
      jiraState.protections.delete(siteId)
      jiraState.deleted.push(siteId)
    },
    getSiteTokenProtection: (siteId: string): SecretAtRestProtection | null =>
      jiraState.protections.get(siteId) ?? null
  }
})

vi.mock('../jenkins/jenkins-server-store', async () => {
  const actual = await vi.importActual<typeof JenkinsStoreModule>('../jenkins/jenkins-server-store')
  return {
    ...actual,
    listJenkinsServers: (): JenkinsServerProfile[] => jenkinsState.servers,
    saveJenkinsServer: (server: JenkinsServerProfile, token: string | null): void => {
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
      jenkinsState.tokens.get(serverId) ?? null,
    getJenkinsServerTokenProtection: (serverId: string): SecretAtRestProtection | null =>
      jenkinsState.protections.get(serverId) ?? null
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
  jiraState.written = []
  jiraState.deleted = []
  jenkinsState.servers = []
  jenkinsState.tokens = new Map()
  jenkinsState.protections = new Map()
  jenkinsState.saved = []
  jenkinsState.removed = []
})

describe('the Jira credential port', () => {
  it('exports one credential per site, carrying the site with its token', () => {
    jiraState.sites = [jiraSite]
    jiraState.tokens.set('site-1', 'jira-token')
    jiraState.protections.set('site-1', 'sealed')

    const [credential] = createHostSettingsJiraPort().list()

    expect(credential).toMatchObject({
      id: 'jira:site-1',
      kind: 'jira',
      protection: 'sealed',
      onlyIfEmpty: false
    })
    expect(JSON.parse(credential.payload)).toEqual({ site: jiraSite, token: 'jira-token' })
  })

  it('skips a site whose token this host cannot read, without dropping the others', () => {
    jiraState.sites = [jiraSite, { ...jiraSite, id: 'site-2' }]
    jiraState.tokens.set('site-2', 'readable')
    jiraState.protections.set('site-1', 'sealed')
    jiraState.protections.set('site-2', 'sealed')

    const credentials = createHostSettingsJiraPort().list()

    expect(credentials.map((credential) => credential.id)).toEqual(['jira:site-2'])
  })

  it('adds a replicated site without moving which site this host is looking at', () => {
    jiraState.activeSiteId = 'site-local'
    jiraState.sites = [{ ...jiraSite, id: 'site-local' }]

    createHostSettingsJiraPort().apply({
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

  it('refuses a malformed payload rather than writing half a site', () => {
    expect(() =>
      createHostSettingsJiraPort().apply({
        id: 'jira:site-1',
        kind: 'jira',
        label: 'Jira Acme',
        protection: 'sealed',
        onlyIfEmpty: false,
        payload: '{"site":{"id":42}}'
      })
    ).toThrow('malformed')
    expect(jiraState.tokens.size).toBe(0)
  })

  it('revokes one site without touching another', () => {
    jiraState.sites = [jiraSite, { ...jiraSite, id: 'site-2' }]
    jiraState.tokens.set('site-1', 'a')
    jiraState.tokens.set('site-2', 'b')
    jiraState.protections.set('site-1', 'sealed')
    jiraState.protections.set('site-2', 'sealed')

    createHostSettingsJiraPort().remove('jira:site-1')

    expect(jiraState.deleted).toEqual(['site-1'])
    expect(jiraState.tokens.has('site-2')).toBe(true)
    expect(jiraState.sites.map((site) => site.id)).toEqual(['site-2'])
  })

  it('ignores a credential id that belongs to another kind', () => {
    jiraState.sites = [jiraSite]

    createHostSettingsJiraPort().remove('jenkins:ci-1')

    expect(jiraState.deleted).toEqual([])
    expect(jiraState.sites).toHaveLength(1)
  })
})

describe('the Jenkins credential port', () => {
  it('exports one credential per server, carrying the profile with its token', () => {
    jenkinsState.servers = [jenkinsServer]
    jenkinsState.tokens.set('ci-1', 'jenkins-token')
    jenkinsState.protections.set('ci-1', 'sealed')

    const [credential] = createHostSettingsJenkinsPort().list()

    expect(credential).toMatchObject({ id: 'jenkins:ci-1', kind: 'jenkins', protection: 'sealed' })
    expect(JSON.parse(credential.payload)).toEqual({
      server: jenkinsServer,
      token: 'jenkins-token'
    })
  })

  it('skips a server with no token on this host', () => {
    jenkinsState.servers = [jenkinsServer]

    expect(createHostSettingsJenkinsPort().list()).toEqual([])
  })

  it('writes the profile and its token together on apply', () => {
    createHostSettingsJenkinsPort().apply({
      id: 'jenkins:ci-1',
      kind: 'jenkins',
      label: 'Jenkins CI',
      protection: 'sealed',
      onlyIfEmpty: false,
      payload: JSON.stringify({ server: jenkinsServer, token: 'jenkins-token' })
    })

    expect(jenkinsState.saved).toEqual([{ server: jenkinsServer, token: 'jenkins-token' }])
  })

  it('normalizes the server URL out of the payload rather than trusting it', () => {
    createHostSettingsJenkinsPort().apply({
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

  it('refuses a payload whose server has no usable URL', () => {
    expect(() =>
      createHostSettingsJenkinsPort().apply({
        id: 'jenkins:ci-1',
        kind: 'jenkins',
        label: 'Jenkins CI',
        protection: 'sealed',
        onlyIfEmpty: false,
        payload: JSON.stringify({ server: { ...jenkinsServer, baseUrl: 'not a url' }, token: 'x' })
      })
    ).toThrow('malformed')
  })

  it('reports a server as unheld once it is revoked', () => {
    const port = createHostSettingsJenkinsPort()
    jenkinsState.servers = [jenkinsServer]
    jenkinsState.tokens.set('ci-1', 'jenkins-token')
    jenkinsState.protections.set('ci-1', 'sealed')

    port.remove('jenkins:ci-1')

    expect(jenkinsState.removed).toEqual(['ci-1'])
    expect(port.protectionOf('jenkins:ci-1')).toBeNull()
  })
})
