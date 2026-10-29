import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { durableWriteTempPath, writeFileDurableSync } from '../durable-file-write'
import {
  adoptLegacyHomeStore,
  resolveLegacyHomeStore,
  type LegacyHomeStoreAdoption
} from '../home-directory-migration'
import { asRecord } from '../../shared/jenkins-payload'
import { isJenkinsUrlUnderBase, normalizeJenkinsBaseUrl } from '../../shared/jenkins-urls'
import type { JenkinsServerProfile } from '../../shared/jenkins-servers'
import {
  credentialFileHasContent,
  restrictCredentialFileToOwner,
  readStoredCredentialToken,
  writeEncryptedCredential
} from '../integration-credential-file'
import { readCredentialFileProtection } from '../credential-file-protection'
import type { SecretAtRestProtection } from '../../shared/secret-at-rest-protection'

/**
 * The user's configured Jenkins servers, on disk as non-secret profiles
 * (`~/.orca-np/jenkins-servers.json`) plus one encrypted API token per server
 * (`~/.orca-np/jenkins-tokens/<id>.enc`).
 *
 * Why the split: only the token is a secret, and keeping the profile readable means the settings
 * pane and the URL matcher can work without touching the OS keyring.
 */

type JenkinsServersFile = {
  version: 1
  servers: JenkinsServerProfile[]
}

/**
 * The profiles file exists but cannot be read as one.
 *
 * Why it throws rather than degrading: the writer reads this list, mutates it and writes it back, so a
 * read that silently answered "no servers" would persist that emptiness over every saved profile and
 * orphan their tokens in `jenkins-tokens/`.
 */
export class JenkinsServerStoreUnreadableError extends Error {
  constructor(
    readonly path: string,
    message: string
  ) {
    super(message)
    this.name = 'JenkinsServerStoreUnreadableError'
  }
}

type JenkinsServersRead = {
  file: JenkinsServersFile
  /** Set when the file exists but is not readable as a profiles file; writes must then refuse. */
  unreadable: JenkinsServerStoreUnreadableError | null
  /** A pre-rename copy this build could not import; reported even though reads still answer. */
  adoptionFailure: Extract<LegacyHomeStoreAdoption, { kind: 'failed' }> | null
}

function getServersFilePath(): string {
  return adoptLegacyHomeStore('jenkins-servers.json')
}

function getTokenPath(serverId: string): string {
  return join(
    adoptLegacyHomeStore('jenkins-tokens'),
    `${Buffer.from(serverId).toString('base64url')}.enc`
  )
}

function readServersFile(): JenkinsServersRead {
  const { path, adoption } = resolveLegacyHomeStore('jenkins-servers.json')
  const adoptionFailure = adoption.kind === 'failed' ? adoption : null
  if (!existsSync(path)) {
    return { file: { version: 1, servers: [] }, unreadable: null, adoptionFailure }
  }
  try {
    const parsed: Partial<JenkinsServersFile> = JSON.parse(
      readFileSync(path, { encoding: 'utf-8' })
    )
    return {
      file: {
        version: 1,
        servers: Array.isArray(parsed.servers)
          ? parsed.servers
              .map(normalizeStoredServer)
              .filter((server): server is JenkinsServerProfile => server !== null)
          : []
      },
      unreadable: null,
      adoptionFailure
    }
  } catch {
    // Why empty rather than a throw here: the panel must still open. The error travels with the read so
    // the writers refuse and the settings card can say what happened.
    return {
      file: { version: 1, servers: [] },
      unreadable: new JenkinsServerStoreUnreadableError(
        path,
        `Could not read the Jenkins servers saved in ${path}, so they are not shown. Repair or move that file aside to start from an empty list.`
      ),
      adoptionFailure
    }
  }
}

/** The saved profiles, refusing when the file is present but unreadable. */
function writableServersFile(): JenkinsServersFile {
  const read = readServersFile()
  if (read.unreadable) {
    throw read.unreadable
  }
  return read.file
}

export function normalizeStoredServer(input: unknown): JenkinsServerProfile | null {
  const record = asRecord(input)
  if (
    !record ||
    typeof record.id !== 'string' ||
    typeof record.baseUrl !== 'string' ||
    typeof record.label !== 'string' ||
    typeof record.username !== 'string'
  ) {
    return null
  }
  const baseUrl = normalizeJenkinsBaseUrl(record.baseUrl)
  return baseUrl === null
    ? null
    : { id: record.id, label: record.label, baseUrl, username: record.username }
}

function writeServersFile(file: JenkinsServersFile): void {
  const path = getServersFilePath()
  const dir = dirname(path)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  // Why the durable helper: a crash mid-write used to leave truncated JSON, which the next launch read
  // as "no servers" and the next save then persisted over every profile.
  writeFileDurableSync(
    durableWriteTempPath(path),
    path,
    `${JSON.stringify(file, null, 2)}\n`,
    0o600
  )
  restrictCredentialFileToOwner(path)
}

export function listJenkinsServers(): JenkinsServerProfile[] {
  return readServersFile().file.servers
}

/**
 * Refuse to show the settings pane an empty list that means something else.
 *
 * Why the empty-store condition on an adoption failure: a store with servers is not misleading, but an
 * empty one says "nothing configured" when the truth is a copy in the pre-rename directory was never
 * imported.
 */
export function assertJenkinsServersReportable(): void {
  const read = readServersFile()
  if (read.unreadable) {
    throw read.unreadable
  }
  if (read.adoptionFailure && read.file.servers.length === 0) {
    throw new JenkinsServerStoreUnreadableError(
      read.adoptionFailure.legacyPath,
      `Could not import the Jenkins servers saved in ${read.adoptionFailure.legacyPath}: ${read.adoptionFailure.reason}`
    )
  }
}

export function hasJenkinsServerToken(serverId: string): boolean {
  // Why content rather than existence: the token file is created empty when a write fails partway, and
  // an empty file authenticates nothing — calling it a token reports the server as unreadable forever
  // and keeps a host on a stale one instead of letting the main clear it.
  return credentialFileHasContent(getTokenPath(serverId))
}

/** How a server's stored token sits on disk, or null when it has none. */
export function getJenkinsServerTokenProtection(serverId: string): SecretAtRestProtection | null {
  return readCredentialFileProtection(getTokenPath(serverId))
}

/**
 * The stored API token, or null when this server has none.
 *
 * Throws `CredentialDecryptionError` when the file holds ciphertext we cannot decrypt (the user
 * denied the keychain prompt after a re-sign); callers classify that as an auth failure rather
 * than pretending the server is unreachable.
 */
export function readJenkinsServerToken(serverId: string): string | null {
  const path = getTokenPath(serverId)
  if (!existsSync(path)) {
    return null
  }
  return readStoredCredentialToken('Jenkins', readFileSync(path))
}

export function saveJenkinsServer(profile: JenkinsServerProfile, apiToken: string | null): void {
  const file = writableServersFile()
  const servers = file.servers.filter((server) => server.id !== profile.id)
  servers.push(profile)
  // Why: write the token first — a profile whose token write failed would look connected and then
  // fail every request with a confusing auth error.
  if (apiToken) {
    const tokenDir = adoptLegacyHomeStore('jenkins-tokens')
    if (!existsSync(tokenDir)) {
      mkdirSync(tokenDir, { recursive: true })
    }
    writeEncryptedCredential('Jenkins', getTokenPath(profile.id), apiToken)
  }
  writeServersFile({ version: 1, servers })
}

export function removeJenkinsServer(serverId: string): boolean {
  // Why before the token is unlinked: an unreadable file cannot prove this server is not in it, and a
  // removal that deleted the token anyway would leave the profile pointing at nothing.
  const file = writableServersFile()
  const servers = file.servers.filter((server) => server.id !== serverId)
  // Why the token is unlinked even when there is no profile to remove: a token left behind by an
  // earlier partial removal keeps `hasJenkinsServerToken` true, so replication reports the removal as
  // unverified on every retry and the stray token can never be cleared.
  const tokenPath = getTokenPath(serverId)
  if (existsSync(tokenPath)) {
    unlinkSync(tokenPath)
  }
  if (servers.length === file.servers.length) {
    return false
  }
  writeServersFile({ version: 1, servers })
  return true
}

export function createJenkinsServerId(): string {
  return randomUUID()
}

/**
 * The server whose configured prefix covers this URL, preferring the longest one.
 *
 * Longest-prefix rather than origin because Jenkins is routinely served under a path, and two
 * instances can share a host.
 */
export function findJenkinsServerForUrl(url: string): JenkinsServerProfile | null {
  let best: JenkinsServerProfile | null = null
  for (const server of listJenkinsServers()) {
    if (!isJenkinsUrlUnderBase(server.baseUrl, url)) {
      continue
    }
    if (!best || server.baseUrl.length > best.baseUrl.length) {
      best = server
    }
  }
  return best
}
