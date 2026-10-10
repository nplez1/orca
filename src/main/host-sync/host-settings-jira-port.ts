import type { ReplicatedHostCredential } from '../../shared/host-settings-replication'
import type { JiraSite } from '../../shared/jira-types'
import {
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
  return {
    kind: HOST_SETTINGS_JIRA_KIND,
    // Why always true: a Jira token lands in the same safeStorage-backed store as the provider keys,
    // so a host that can hold one of those sealed can hold these.
    canSeal: canSealReplicatedCredential,
    protectionOf: (id) => {
      const siteId = siteIdOf(id)
      return siteId !== null && hasStoredToken(siteId) ? getSiteTokenProtection(siteId) : null
    },
    list: () => {
      const credentials: ReplicatedHostCredential[] = []
      for (const site of getSiteFile().sites) {
        const protection = getSiteTokenProtection(site.id)
        if (protection === null) {
          continue
        }
        let token: string | null
        try {
          token = readToken(site.id)
        } catch {
          // Why skipped: a token this host cannot decrypt is one it cannot send, and it must not stop
          // the other sites from replicating.
          continue
        }
        if (token === null) {
          continue
        }
        credentials.push({
          id: `${HOST_SETTINGS_JIRA_KIND}:${site.id}`,
          kind: HOST_SETTINGS_JIRA_KIND,
          label: `Jira ${site.displayName || site.siteUrl}`,
          protection,
          onlyIfEmpty: false,
          payload: JSON.stringify({ site, token } satisfies JiraSiteReplicationPayload)
        })
      }
      return credentials
    },
    apply: (credential) => {
      const decoded = decode(credential.payload)
      if (decoded === null) {
        throw new Error('Jira site payload is malformed')
      }
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
      deleteToken(siteId)
      const file = getSiteFile()
      writeSiteFile({ ...file, sites: file.sites.filter((site) => site.id !== siteId) })
    }
  }
}
