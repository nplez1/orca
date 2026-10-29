import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { durableWriteTempPath, writeFileDurableSync } from '../durable-file-write'
import {
  adoptLegacyHomeStore,
  resolveLegacyHomeStore,
  type LegacyHomeStoreAdoption
} from '../home-directory-migration'
import { writeEncryptedCredential } from '../integration-credential-file'
import { readCredentialFileProtection } from '../credential-file-protection'
import type { SecretAtRestProtection } from '../../shared/secret-at-rest-protection'
import type { JiraSite, JiraSiteSelection } from '../../shared/jira/jira-types'
import { createIntegrationStateFileCache } from '../integration-state-file-cache'
import { isJiraGatewayBaseUrl } from './gateway-base-url'
import { createIntegrationTokenFileCache } from '../integration-token-file-cache'

export type JiraSiteFile = {
  version: 1
  activeSiteId: string | null
  selectedSiteId: JiraSiteSelection | null
  sites: JiraSite[]
}

const siteFileCache = createIntegrationStateFileCache<JiraSiteFileRead>({
  filePath: getSiteFilePath,
  readFromDisk: readSiteFileFromDisk
})
const tokenFileCache = createIntegrationTokenFileCache({ service: 'Jira', filePath: getTokenPath })

type JiraSiteFileRead = {
  file: JiraSiteFile
  /** Set when the file could not be read or parsed; writes must then refuse. */
  unreadable: JiraSiteFileUnreadableError | null
  /** A pre-rename copy this build could not import, or null. */
  adoptionFailure: Extract<LegacyHomeStoreAdoption, { kind: 'failed' }> | null
}

/** The sites file exists but cannot be read as one: writing over it would erase every site. */
export class JiraSiteFileUnreadableError extends Error {
  constructor(
    readonly path: string,
    message: string
  ) {
    super(message)
    this.name = 'JiraSiteFileUnreadableError'
  }
}

export function getCredentialError(siteId: string): string | undefined {
  return tokenFileCache.error(siteId)
}

function getSiteFilePath(): string {
  return adoptLegacyHomeStore('jira-sites.json')
}
export function getTokenDir(): string {
  return adoptLegacyHomeStore('jira-tokens')
}

function getTokenPath(siteId: string): string {
  return join(getTokenDir(), `${Buffer.from(siteId).toString('base64url')}.enc`)
}

function ensureOrcaDir(): void {
  mkdirSync(dirname(getSiteFilePath()), { recursive: true })
}

function ensureTokenDir(): void {
  const dir = getTokenDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function emptySiteFile(): JiraSiteFile {
  return {
    version: 1,
    activeSiteId: null,
    selectedSiteId: null,
    sites: []
  }
}

export function hasStoredToken(siteId: string): boolean {
  return tokenFileCache.has(siteId)
}

export function normalizeSite(input: unknown): JiraSite | null {
  if (!input || typeof input !== 'object') {
    return null
  }
  const record = input as Record<string, unknown>
  if (
    typeof record.id !== 'string' ||
    typeof record.siteUrl !== 'string' ||
    typeof record.email !== 'string' ||
    typeof record.displayName !== 'string' ||
    typeof record.accountId !== 'string'
  ) {
    return null
  }
  if (record.apiBaseUrl !== undefined && !isJiraGatewayBaseUrl(record.apiBaseUrl)) {
    return null
  }
  if (record.authType !== 'server' && !record.email && !isJiraGatewayBaseUrl(record.apiBaseUrl)) {
    return null
  }
  return {
    id: record.id,
    siteUrl: record.siteUrl,
    email: record.email,
    displayName: record.displayName,
    accountId: record.accountId,
    // Sites saved before self-hosted support have no authType; they are Cloud.
    authType: record.authType === 'server' ? 'server' : 'cloud',
    ...(record.authType !== 'server' && isJiraGatewayBaseUrl(record.apiBaseUrl)
      ? { apiBaseUrl: record.apiBaseUrl }
      : {})
  }
}

function readSiteFileFromDisk(): JiraSiteFileRead {
  const { path, adoption } = resolveLegacyHomeStore('jira-sites.json')
  const adoptionFailure = adoption.kind === 'failed' ? adoption : null
  if (!existsSync(path)) {
    return { file: emptySiteFile(), unreadable: null, adoptionFailure }
  }
  try {
    const parsed = JSON.parse(readFileSync(path, { encoding: 'utf-8' })) as Partial<JiraSiteFile>
    const sites = Array.isArray(parsed.sites)
      ? parsed.sites
          .map((site) => normalizeSite(site))
          .filter((site): site is JiraSite => site !== null)
      : []
    const activeSiteId =
      typeof parsed.activeSiteId === 'string' &&
      sites.some((site) => site.id === parsed.activeSiteId)
        ? parsed.activeSiteId
        : (sites[0]?.id ?? null)
    const selectedSiteId =
      parsed.selectedSiteId === 'all' ||
      (typeof parsed.selectedSiteId === 'string' &&
        sites.some((site) => site.id === parsed.selectedSiteId))
        ? parsed.selectedSiteId
        : activeSiteId
    return {
      file: { version: 1, activeSiteId, selectedSiteId, sites },
      unreadable: null,
      adoptionFailure
    }
  } catch {
    // Why empty rather than a throw here: the pane must still open. The error travels with the read so
    // the writer refuses and the status can say what happened.
    return {
      file: emptySiteFile(),
      unreadable: new JiraSiteFileUnreadableError(
        path,
        `Could not read the Jira sites saved in ${path}, so they are not shown`
      ),
      adoptionFailure
    }
  }
}

/** A problem the connection status should carry, or null when the store is healthy. */
export function getSiteFileProblem(): string | null {
  const read = siteFileCache.get()
  if (read.unreadable) {
    return read.unreadable.message
  }
  if (read.adoptionFailure && read.file.sites.length === 0) {
    return `Could not import the Jira sites saved in ${read.adoptionFailure.legacyPath}: ${read.adoptionFailure.reason}`
  }
  return null
}

export function getSiteFile(): JiraSiteFile {
  const file = siteFileCache.get().file
  return selectableSiteFile(file)
}

function selectableSiteFile(file: JiraSiteFile): JiraSiteFile {
  const sites = file.sites.filter((site) => hasStoredToken(site.id))
  const activeSiteId =
    file.activeSiteId && sites.some((site) => site.id === file.activeSiteId)
      ? file.activeSiteId
      : (sites[0]?.id ?? null)
  const selectedSiteId =
    file.selectedSiteId === 'all'
      ? 'all'
      : file.selectedSiteId && sites.some((site) => site.id === file.selectedSiteId)
        ? file.selectedSiteId
        : activeSiteId

  return {
    version: 1,
    activeSiteId,
    selectedSiteId,
    sites
  }
}

/** Refuse a mutation when the file it would rewrite cannot be read. */
export function assertSiteFileWritable(): void {
  const read = siteFileCache.get()
  if (read.unreadable) {
    throw read.unreadable
  }
}

export function writeSiteFile(file: JiraSiteFile): void {
  // Why refuse: this call reads the file, changes it and writes it back, so a read that answered
  // "no sites" would persist that emptiness over every saved site and orphan their tokens.
  assertSiteFileWritable()
  ensureOrcaDir()
  const path = getSiteFilePath()
  const next = selectableSiteFile(file)
  // Why the durable helper: a crash mid-write left truncated JSON, which the next launch read as "no
  // sites" and the next save then persisted.
  writeFileDurableSync(durableWriteTempPath(path), path, JSON.stringify(next, null, 2), 0o600)
  siteFileCache.invalidate()
}

export function readToken(siteId: string): string | null {
  return tokenFileCache.read(siteId)
}

/** How a site's stored token sits on disk, or null when none is stored. */
export function getSiteTokenProtection(siteId: string): SecretAtRestProtection | null {
  return readCredentialFileProtection(getTokenPath(siteId))
}

export function saveToken(siteId: string, apiToken: string): void {
  ensureOrcaDir()
  ensureTokenDir()
  writeEncryptedCredential('Jira', getTokenPath(siteId), apiToken)
  // The next action reads the actual file, including any overlapping writer's replacement.
  tokenFileCache.forget(siteId)
}

export function deleteToken(siteId: string): void {
  tokenFileCache.forget(siteId)
  try {
    unlinkSync(getTokenPath(siteId))
  } catch {}
}
