import type { ReplicatedHostCredential } from '../../shared/host-settings-replication'
import type { JenkinsServerProfile } from '../../shared/jenkins-servers'
import type { SecretAtRestProtection } from '../../shared/secret-at-rest-protection'
import {
  getJenkinsServerTokenProtection,
  hasJenkinsServerToken,
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
  // Why one read per server, as the Jira adapter does: `list()` and `unreadableIds()` must not disagree
  // about a token, or a server lands in neither list and the sender puts it in the removal list.
  function readServerToken(
    serverId: string
  ):
    | { kind: 'absent' }
    | { kind: 'unreadable' }
    | { kind: 'token'; token: string; protection: SecretAtRestProtection | null } {
    if (!hasJenkinsServerToken(serverId)) {
      return { kind: 'absent' }
    }
    let token: string | null
    try {
      token = readJenkinsServerToken(serverId)
    } catch {
      return { kind: 'unreadable' }
    }
    if (token === null) {
      return { kind: 'unreadable' }
    }
    return { kind: 'token', token, protection: getJenkinsServerTokenProtection(serverId) }
  }

  return {
    kind: HOST_SETTINGS_JENKINS_KIND,
    canSeal: canSealReplicatedCredential,
    unreadableIds: () => {
      const unreadable: string[] = []
      for (const server of listJenkinsServers()) {
        if (readServerToken(server.id).kind === 'unreadable') {
          unreadable.push(`${HOST_SETTINGS_JENKINS_KIND}:${server.id}`)
        }
      }
      return unreadable
    },
    protectionOf: (id) => {
      const serverId = serverIdOf(id)
      if (serverId === null) {
        return null
      }
      const read = readServerToken(serverId)
      // Why plaintext rather than null: see the Jira adapter — null claims this host holds nothing, and
      // that is what turns an unreadable token into a removal reported as verified. Why not `sealed` for a
      // classification that failed: overstating it records a plaintext copy as sealed.
      return read.kind === 'absent'
        ? null
        : read.kind === 'unreadable'
          ? 'plaintext'
          : (read.protection ?? 'plaintext')
    },
    list: () => {
      const credentials: ReplicatedHostCredential[] = []
      for (const server of listJenkinsServers()) {
        const read = readServerToken(server.id)
        if (read.kind !== 'token') {
          continue
        }
        credentials.push({
          id: `${HOST_SETTINGS_JENKINS_KIND}:${server.id}`,
          kind: HOST_SETTINGS_JENKINS_KIND,
          label: `Jenkins ${server.label || server.baseUrl}`,
          // Why sealed when the classification failed: see the Jira adapter.
          protection: read.protection ?? 'sealed',
          onlyIfEmpty: false,
          payload: JSON.stringify({
            server,
            token: read.token
          } satisfies JenkinsServerReplicationPayload)
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
