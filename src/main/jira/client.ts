import { CredentialDecryptionError } from '../integration-credential-file'
import type {
  JiraAuthType,
  JiraConnectArgs,
  JiraConnectionStatus,
  JiraSite,
  JiraSiteSelection,
  JiraViewer
} from '../../shared/jira/jira-types'
import { clearAttachmentImagesForSite } from './attachments/image-cache'
import { noteReplicatedCredentialChanged } from '../host-sync/host-settings-replication-service'
import { acquire, release } from './request-queue'
import {
  assertSiteFileWritable,
  getCredentialError,
  deleteToken,
  getSiteFile,
  getSiteFileProblem,
  hasStoredToken,
  readToken,
  saveToken,
  writeSiteFile,
  getSiteTokenProtection
} from './site-credential-store'
import {
  apiBasePath,
  authHeader,
  JiraApiError,
  jiraRequest,
  type JiraClientForSite
} from './authenticated-request'
import { getSiteId, normalizeJiraSiteUrl, siteToViewer, toViewer } from './site-identity'
import { verifyJiraCredentials } from './credential-verification'

export function getClients(selection?: JiraSiteSelection | null): JiraClientForSite[] {
  const file = getSiteFile()
  const selected = selection ?? file.selectedSiteId ?? file.activeSiteId
  const isAllSelection = selected === 'all'
  const sites = isAllSelection
    ? file.sites
    : file.sites.filter((site) => site.id === (selected ?? file.activeSiteId))

  return sites.flatMap((site) => {
    let token: string | null
    try {
      token = readToken(site.id)
    } catch (error) {
      // For all-sites reads, skip unreadable credentials; explicit site reads still throw and status retains the error.
      if (isAllSelection && error instanceof CredentialDecryptionError) {
        return []
      }
      throw error
    }
    return token ? [{ site, authorization: authHeader(site.email, token, site.authType) }] : []
  })
}

/** Resolves the one site a board- or sprint-scoped Jira read needs. */
export function getSingleClient(selection?: JiraSiteSelection | null): JiraClientForSite {
  const entries = getClients(selection)
  if (entries.length !== 1) {
    throw new Error('A single Jira site is required for board data.')
  }
  return entries[0]
}

export function getStatus(): JiraConnectionStatus {
  const file = getSiteFile()
  const sites = file.sites.filter((site) => hasStoredToken(site.id))
  const activeSite = sites.find((site) => site.id === file.activeSiteId) ?? sites[0] ?? null
  // Why the site-file problem joins this field: an unreadable or un-imported
  // `jira-sites.json` shows as configured-nothing, which is the same silent dead end a credential
  // this build cannot decrypt produces, and this is the channel that already carries that.
  const credentialError =
    sites.map((site) => getCredentialError(site.id)).find((message) => message !== undefined) ??
    getSiteFileProblem() ??
    undefined
  // Protection is host-wide: inactive sites with plaintext credentials still matter.
  const credentialProtection = sites.some((site) => getSiteTokenProtection(site.id) === 'plaintext')
    ? 'plaintext'
    : null
  return {
    connected: sites.length > 0,
    viewer: siteToViewer(activeSite),
    sites,
    activeSiteId: activeSite?.id ?? null,
    selectedSiteId: file.selectedSiteId ?? activeSite?.id ?? null,
    ...(credentialError ? { credentialError } : {}),
    credentialProtection,
    supportsScopedTokens: true
  }
}

export async function connect(
  args: JiraConnectArgs
): Promise<{ ok: true; viewer: JiraViewer } | { ok: false; error: string }> {
  let siteUrl: string
  try {
    siteUrl = normalizeJiraSiteUrl(args.siteUrl)
  } catch {
    return { ok: false, error: 'Enter a valid Jira site URL.' }
  }

  const authType: JiraAuthType = args.authType === 'server' ? 'server' : 'cloud'
  const email = args.email.trim()
  const apiToken = args.apiToken.trim()
  if (authType === 'server') {
    if (!apiToken) {
      // A username present means classic Basic auth (password); its absence
      // means the credential is a personal access token sent as Bearer.
      return {
        ok: false,
        error: email ? 'Password is required.' : 'Personal access token is required.'
      }
    }
  } else if (!apiToken) {
    return { ok: false, error: 'API token is required.' }
  }

  await acquire()
  try {
    // Before the network call and before saveToken: a file this build cannot read would otherwise
    // collect an orphan token for a site that can never be written down.
    assertSiteFileWritable()
    const { viewer, apiBaseUrl } = await verifyJiraCredentials(siteUrl, email, apiToken, authType)
    // PAT sites lack email; verified viewer identity prevents same-host account collisions.
    const id = getSiteId(siteUrl, email || viewer.accountId)
    const site: JiraSite = {
      id,
      siteUrl,
      email,
      displayName: viewer.displayName,
      accountId: viewer.accountId,
      authType,
      ...(apiBaseUrl ? { apiBaseUrl } : {})
    }
    clearAttachmentImagesForSite(id)
    saveToken(id, apiToken)
    noteReplicatedCredentialChanged()
    const file = getSiteFile()
    writeSiteFile({
      version: 1,
      activeSiteId: id,
      selectedSiteId: id,
      sites: [site, ...file.sites.filter((entry) => entry.id !== id)]
    })
    return { ok: true, viewer }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Connection failed.' }
  } finally {
    release()
  }
}

export function disconnect(siteId?: string): void {
  const file = getSiteFile()
  const ids = siteId ? [siteId] : file.sites.map((site) => site.id)
  for (const id of ids) {
    deleteToken(id)
  }
  noteReplicatedCredentialChanged()
  // Why: drop cached attachment data URLs for disconnected sites so main does
  // not retain multi-MB strings after logout.
  clearAttachmentImagesForSite(siteId)
  writeSiteFile({
    version: 1,
    activeSiteId: file.activeSiteId,
    selectedSiteId: file.selectedSiteId,
    sites: file.sites.filter((site) => !ids.includes(site.id))
  })
}

export function selectSite(siteId: JiraSiteSelection): JiraConnectionStatus {
  const file = getSiteFile()
  if (siteId !== 'all' && !file.sites.some((site) => site.id === siteId)) {
    return getStatus()
  }
  writeSiteFile({
    ...file,
    activeSiteId: siteId === 'all' ? file.activeSiteId : siteId,
    selectedSiteId: siteId
  })
  return getStatus()
}

export async function testConnection(
  siteId?: string
): Promise<{ ok: true; viewer: JiraViewer } | { ok: false; error: string }> {
  let client: JiraClientForSite | undefined
  try {
    client = getClients(siteId)[0]
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Connection failed.' }
  }
  if (!client) {
    return { ok: false, error: 'Not connected to Jira.' }
  }
  await acquire()
  try {
    const viewer = toViewer(
      (await jiraRequest(client, `${apiBasePath(client.site)}/myself`)) as Record<string, unknown>,
      client.site.email
    )
    return { ok: true, viewer }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Connection failed.' }
  } finally {
    release()
  }
}

export function clearToken(siteId: string): void {
  deleteToken(siteId)
  noteReplicatedCredentialChanged()
  // Why: auth failure removes the site; drop cached attachment data URLs too.
  clearAttachmentImagesForSite(siteId)
  const file = getSiteFile()
  writeSiteFile({ ...file, sites: file.sites.filter((site) => site.id !== siteId) })
}

export function isAuthError(error: unknown): boolean {
  // Jira 403 may mean missing project permissions; only an unscoped 401 invalidates the credential.
  return error instanceof JiraApiError && error.status === 401 && !error.scopeMismatch
}
