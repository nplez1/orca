import type { ReplicatedHostCredential } from '../../shared/host-settings-replication'
import type { JiraSite } from '../../shared/jira/jira-types'
import type { SecretAtRestProtection } from '../../shared/secret-at-rest-protection'
import {
  assertSiteFileWritable,
  deleteToken,
  getSiteFile,
  getSiteTokenProtection,
  hasStoredToken,
  normalizeSite,
  readToken,
  saveToken,
  writeSiteFile
} from '../jira/site-credential-store'
import type { HostSettingsCredentialPort } from './host-settings-credential-port'
import { canSealReplicatedCredential } from './host-settings-credential-port'

/**
 * Jira sites and their tokens, as one credential per site.
 *
 * Why per site rather than one blob: revoking one site has to be possible without taking the host's
 * other sites with it, and a payload that names one site is one whose outcome the main can report.
 *
 * Why the active/selected site is left out: that is which site *this* machine is looking at, so it is
 * host-local UI state — the same reason `activeWorkspaceExecutionHostId` is.
 */
export const HOST_SETTINGS_JIRA_KIND = 'jira'

export type JiraSiteReplicationPayload = { site: JiraSite; token: string }

/** `jira:<siteId>`, or null when the id names something else. A site id may itself contain `:`. */
function siteIdOf(id: string): string | null {
  const prefix = `${HOST_SETTINGS_JIRA_KIND}:`
  return id.startsWith(prefix) && id.length > prefix.length ? id.slice(prefix.length) : null
}

function decode(payload: string): JiraSiteReplicationPayload | null {
  try {
    const parsed = JSON.parse(payload)
    // Why the site goes through normalizeSite: this payload crosses a wire, and a truncated or
    // hand-edited one must not put a non-string where the request builder expects a URL.
    const site = normalizeSite(parsed?.site)
    return site === null || typeof parsed?.token !== 'string' ? null : { site, token: parsed.token }
  } catch {
    return null
  }
}

export function createHostSettingsJiraPort(): HostSettingsCredentialPort {
  /**
   * One site's token, classified once so the two callers that read it cannot disagree.
   *
   * Why a shared read: `list()` skips what it cannot classify and `unreadableIds()` skips what it can
   * read, so a site that one sees as readable and the other as not lands in neither list — and the
   * sender then puts it in the removal list. That is the read failure this port exists to report.
   *
   * Why the classification can be null here and the two callers then disagree on purpose: what this host
   * sends the main must not understate protection (a host that cannot seal would accept a downgrade), and
   * what this host claims about itself must not overstate it (a plaintext copy would be recorded as sealed).
   */
  function readSiteToken(
    siteId: string
  ):
    | { kind: 'absent' }
    | { kind: 'unreadable' }
    | { kind: 'token'; token: string; protection: SecretAtRestProtection | null } {
    if (!hasStoredToken(siteId)) {
      return { kind: 'absent' }
    }
    let token: string | null
    try {
      token = readToken(siteId)
    } catch {
      return { kind: 'unreadable' }
    }
    if (token === null) {
      return { kind: 'unreadable' }
    }
    return { kind: 'token', token, protection: getSiteTokenProtection(siteId) }
  }

  return {
    kind: HOST_SETTINGS_JIRA_KIND,
    // Why always true: a Jira token lands in the same safeStorage-backed store as the provider keys,
    // so a host that can hold one of those sealed can hold these.
    canSeal: canSealReplicatedCredential,
    unreadableIds: () => {
      const unreadable: string[] = []
      for (const site of getSiteFile().sites) {
        if (readSiteToken(site.id).kind === 'unreadable') {
          unreadable.push(`${HOST_SETTINGS_JIRA_KIND}:${site.id}`)
        }
      }
      return unreadable
    },
    protectionOf: (id) => {
      const siteId = siteIdOf(id)
      if (siteId === null) {
        return null
      }
      const read = readSiteToken(siteId)
      // Why plaintext rather than null for a present token that cannot be read: null means "this host
      // holds nothing", which is how a failed read becomes a removal the receiver reports as verified.
      return read.kind === 'absent'
        ? null
        : read.kind === 'unreadable'
          ? 'plaintext'
          : (read.protection ?? 'plaintext')
    },
    list: () => {
      const credentials: ReplicatedHostCredential[] = []
      for (const site of getSiteFile().sites) {
        const read = readSiteToken(site.id)
        if (read.kind !== 'token') {
          continue
        }
        credentials.push({
          id: `${HOST_SETTINGS_JIRA_KIND}:${site.id}`,
          kind: HOST_SETTINGS_JIRA_KIND,
          label: `Jira ${site.displayName || site.siteUrl}`,
          // Why sealed when the classification failed: understating protection is what would let a host
          // that cannot seal accept this value as plaintext.
          protection: read.protection ?? 'sealed',
          onlyIfEmpty: false,
          payload: JSON.stringify({ site, token: read.token } satisfies JiraSiteReplicationPayload)
        })
      }
      return credentials
    },
    apply: (credential) => {
      const decoded = decode(credential.payload)
      if (decoded === null) {
        throw new Error('Jira site payload is malformed')
      }
      // Why cross-check the id against the payload: a payload whose id names one site while its body
      // carries another would be written under the body's id, and the main would then record a holding
      // against the id it sent — so revocation would verify the wrong site and report it removed.
      if (credential.id !== `${HOST_SETTINGS_JIRA_KIND}:${decoded.site.id}`) {
        throw new Error('Jira site payload does not match the credential it arrived as')
      }
      // Why before the token: a sites file this build cannot read would otherwise collect a token for a
      // site that can never be written down, which is the orphan R4 names.
      assertSiteFileWritable()
      saveToken(decoded.site.id, decoded.token)
      // Why merge rather than replace: the file also records which site this host is looking at, and
      // a replicated site list must not move that.
      const file = getSiteFile()
      writeSiteFile({
        ...file,
        sites: [...file.sites.filter((site) => site.id !== decoded.site.id), decoded.site]
      })
    },
    remove: (id) => {
      const siteId = siteIdOf(id)
      if (siteId === null) {
        return
      }
      // Why before the deletion: an unreadable file cannot show this site is gone, so removing the token
      // would leave the record pointing at nothing.
      assertSiteFileWritable()
      deleteToken(siteId)
      const file = getSiteFile()
      writeSiteFile({ ...file, sites: file.sites.filter((site) => site.id !== siteId) })
    }
  }
}
