import type { ReplicatedHostCredential } from '../../shared/host-settings-replication'
import type { JenkinsServerProfile } from '../../shared/jenkins-servers'
import {
  getJenkinsServerTokenProtection,
  listJenkinsServers,
  normalizeStoredServer,
  readJenkinsServerToken,
  removeJenkinsServer,
  saveJenkinsServer
} from '../jenkins/jenkins-server-store'
import type { HostSettingsCredentialPort } from './host-settings-credential-port'
import { canSealReplicatedCredential } from './host-settings-credential-port'

/**
 * Jenkins servers and their tokens, as one credential per server.
 *
 * The server profile travels with its token because the profile is what decides which URLs this host
 * routes to Jenkins at all: a token without its server would authenticate nothing.
 */
export const HOST_SETTINGS_JENKINS_KIND = 'jenkins'

export type JenkinsServerReplicationPayload = { server: JenkinsServerProfile; token: string }

function serverIdOf(id: string): string | null {
  const prefix = `${HOST_SETTINGS_JENKINS_KIND}:`
  return id.startsWith(prefix) && id.length > prefix.length ? id.slice(prefix.length) : null
}

function normalizeServer(input: unknown): JenkinsServerProfile | null {
  return normalizeStoredServer(input)
}

function decode(payload: string): JenkinsServerReplicationPayload | null {
  try {
    const parsed = JSON.parse(payload)
    const server = normalizeServer(parsed?.server)
    return server === null || typeof parsed?.token !== 'string'
      ? null
      : { server, token: parsed.token }
  } catch {
    return null
  }
}

export function createHostSettingsJenkinsPort(): HostSettingsCredentialPort {
  return {
    kind: HOST_SETTINGS_JENKINS_KIND,
    canSeal: canSealReplicatedCredential,
    unreadableIds: () => {
      const unreadable: string[] = []
      for (const server of listJenkinsServers()) {
        if (getJenkinsServerTokenProtection(server.id) === null) {
          continue
        }
        try {
          if (readJenkinsServerToken(server.id) === null) {
            unreadable.push(`${HOST_SETTINGS_JENKINS_KIND}:${server.id}`)
          }
        } catch {
          unreadable.push(`${HOST_SETTINGS_JENKINS_KIND}:${server.id}`)
        }
      }
      return unreadable
    },
    protectionOf: (id) => {
      const serverId = serverIdOf(id)
      return serverId === null ? null : getJenkinsServerTokenProtection(serverId)
    },
    list: () => {
      const credentials: ReplicatedHostCredential[] = []
      for (const server of listJenkinsServers()) {
        const protection = getJenkinsServerTokenProtection(server.id)
        if (protection === null) {
          continue
        }
        let token: string | null
        try {
          token = readJenkinsServerToken(server.id)
        } catch {
          // Why skipped: a token this host cannot decrypt is one it cannot send, and it must not stop
          // the other servers from replicating — the same rule the Jira adapter follows.
          continue
        }
        if (token === null) {
          continue
        }
        credentials.push({
          id: `${HOST_SETTINGS_JENKINS_KIND}:${server.id}`,
          kind: HOST_SETTINGS_JENKINS_KIND,
          label: `Jenkins ${server.label || server.baseUrl}`,
          protection,
          onlyIfEmpty: false,
          payload: JSON.stringify({ server, token } satisfies JenkinsServerReplicationPayload)
        })
      }
      return credentials
    },
    apply: (credential) => {
      const decoded = decode(credential.payload)
      if (decoded === null) {
        throw new Error('Jenkins server payload is malformed')
      }
      // Why cross-check the id against the payload: see the Jira adapter — a mismatch would be written
      // under the body's id and recorded under the id the main sent.
      if (credential.id !== `${HOST_SETTINGS_JENKINS_KIND}:${decoded.server.id}`) {
        throw new Error('Jenkins server payload does not match the credential it arrived as')
      }
      saveJenkinsServer(decoded.server, decoded.token)
    },
    remove: (id) => {
      const serverId = serverIdOf(id)
      if (serverId !== null) {
        removeJenkinsServer(serverId)
      }
    }
  }
}
