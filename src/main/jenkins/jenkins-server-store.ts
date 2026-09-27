import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { asRecord } from '../../shared/jenkins-payload'
import { isJenkinsUrlUnderBase, normalizeJenkinsBaseUrl } from '../../shared/jenkins-urls'
import type { JenkinsServerProfile } from '../../shared/jenkins-servers'
import {
  restrictCredentialFileToOwner,
  readStoredCredentialToken,
  writeEncryptedCredential
} from '../integration-credential-file'

/**
 * The user's configured Jenkins servers, on disk as non-secret profiles
 * (`~/.orca/jenkins-servers.json`) plus one encrypted API token per server
 * (`~/.orca/jenkins-tokens/<id>.enc`).
 *
 * Why the split: only the token is a secret, and keeping the profile readable means the settings
 * pane and the URL matcher can work without touching the OS keyring.
 */

type JenkinsServersFile = {
  version: 1
  servers: JenkinsServerProfile[]
}

function getServersFilePath(): string {
  return join(homedir(), '.orca', 'jenkins-servers.json')
}

function getTokenPath(serverId: string): string {
  return join(
    homedir(),
    '.orca',
    'jenkins-tokens',
    `${Buffer.from(serverId).toString('base64url')}.enc`
  )
}

function readServersFile(): JenkinsServersFile {
  const path = getServersFilePath()
  if (!existsSync(path)) {
    return { version: 1, servers: [] }
  }
  try {
    const parsed: Partial<JenkinsServersFile> = JSON.parse(
      readFileSync(path, { encoding: 'utf-8' })
    )
    return {
      version: 1,
      servers: Array.isArray(parsed.servers)
        ? parsed.servers
            .map(normalizeStoredServer)
            .filter((server): server is JenkinsServerProfile => server !== null)
        : []
    }
  } catch {
    // A corrupt file must not take the Checks panel down with it.
    return { version: 1, servers: [] }
  }
}

function normalizeStoredServer(input: unknown): JenkinsServerProfile | null {
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
  const dir = join(homedir(), '.orca')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  const path = getServersFilePath()
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 })
  restrictCredentialFileToOwner(path)
}

export function listJenkinsServers(): JenkinsServerProfile[] {
  return readServersFile().servers
}

export function hasJenkinsServerToken(serverId: string): boolean {
  return existsSync(getTokenPath(serverId))
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
  const file = readServersFile()
  const servers = file.servers.filter((server) => server.id !== profile.id)
  servers.push(profile)
  // Why: write the token first — a profile whose token write failed would look connected and then
  // fail every request with a confusing auth error.
  if (apiToken) {
    const tokenDir = join(homedir(), '.orca', 'jenkins-tokens')
    if (!existsSync(tokenDir)) {
      mkdirSync(tokenDir, { recursive: true })
    }
    writeEncryptedCredential('Jenkins', getTokenPath(profile.id), apiToken)
  }
  writeServersFile({ version: 1, servers })
}

export function removeJenkinsServer(serverId: string): boolean {
  const file = readServersFile()
  const servers = file.servers.filter((server) => server.id !== serverId)
  if (servers.length === file.servers.length) {
    return false
  }
  writeServersFile({ version: 1, servers })
  const tokenPath = getTokenPath(serverId)
  if (existsSync(tokenPath)) {
    unlinkSync(tokenPath)
  }
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
