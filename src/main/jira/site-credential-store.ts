import { credentialFileExists, inCredentialFileOrder } from '../credentials/credential-file-io'
import { mkdir, readFile, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { durableWriteTempPath, writeFileDurable } from '../filesystem/durable-file-write'
import {
  adoptLegacyHomeStore,
  resolveLegacyHomeStore,
  type LegacyHomeStoreAdoption
} from '../home-directory-migration'
import { writeEncryptedCredential } from '../credentials/integration-credential-file'
import { readCredentialFileProtection } from '../credentials/credential-file-protection'
import type { SecretAtRestProtection } from '../../shared/secure-storage/secret-at-rest-protection'
import type { JiraSite, JiraSiteSelection } from '../../shared/jira/jira-types'
import { createIntegrationStateFileCache } from '../credentials/integration-state-file-cache'
import { isJiraGatewayBaseUrl } from './gateway-base-url'
import { resolveJiraAuthType } from './site-identity'
import { createIntegrationTokenFileCache } from '../credentials/integration-token-file-cache'

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

export async function getCredentialError(siteId: string): Promise<string | undefined> {
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

async function ensureOrcaDir(): Promise<void> {
  await mkdir(dirname(getSiteFilePath()), { recursive: true })
}

async function ensureTokenDir(): Promise<void> {
  const dir = getTokenDir()
  if (!(await credentialFileExists(dir))) {
    await mkdir(dir, { recursive: true })
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

export async function hasStoredToken(siteId: string): Promise<boolean> {
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
  // An emailless server record is a PAT site; coercing it to Cloud would drop it and orphan its token.
  const authType =
    record.authType === 'server' && !record.email
      ? 'server'
      : resolveJiraAuthType(record.siteUrl, record.authType)
  if (authType !== 'server' && !record.email && !isJiraGatewayBaseUrl(record.apiBaseUrl)) {
    return null
  }
  return {
    id: record.id,
    siteUrl: record.siteUrl,
    email: record.email,
    displayName: record.displayName,
    accountId: record.accountId,
    authType,
    ...(authType !== 'server' && isJiraGatewayBaseUrl(record.apiBaseUrl)
      ? { apiBaseUrl: record.apiBaseUrl }
      : {})
  }
}

async function readSiteFileFromDisk(): Promise<JiraSiteFileRead> {
  const { path, adoption } = resolveLegacyHomeStore('jira-sites.json')
  const adoptionFailure = adoption.kind === 'failed' ? adoption : null
  if (!(await credentialFileExists(path))) {
    return { file: emptySiteFile(), unreadable: null, adoptionFailure }
  }
  try {
    const parsed: Partial<JiraSiteFile> = JSON.parse(await readFile(path, { encoding: 'utf-8' }))
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
        `Could not read the Jira sites saved in ${path}, so they are not shown. Repair or move that file aside to start from an empty list.`
      ),
      adoptionFailure
    }
  }
}

/** A problem the connection status should carry, or null when the store is healthy. */
export async function getSiteFileProblem(): Promise<string | null> {
  const read = await siteFileCache.get()
  if (read.unreadable) {
    return read.unreadable.message
  }
  if (read.adoptionFailure && read.file.sites.length === 0) {
    return `Could not import the Jira sites saved in ${read.adoptionFailure.legacyPath}: ${read.adoptionFailure.reason}`
  }
  return null
}

export async function getSiteFile(): Promise<JiraSiteFile> {
  // The registry queue keeps a token/reconnect write from landing between this read and its consumer.
  return inCredentialFileOrder(getSiteFilePath(), async () => {
    const read = await siteFileCache.get()
    return selectableSiteFile(read.file)
  })
}

async function selectableSiteFile(file: JiraSiteFile): Promise<JiraSiteFile> {
  const presence = await Promise.all(file.sites.map((site) => hasStoredToken(site.id)))
  const sites = file.sites.filter((_, index) => presence[index])
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
export async function assertSiteFileWritable(): Promise<void> {
  const read = await siteFileCache.get()
  if (read.unreadable) {
    throw read.unreadable
  }
}

export async function writeSiteFile(file: JiraSiteFile): Promise<void> {
  return inCredentialFileOrder(getSiteFilePath(), async () => {
    // Why refuse: this call reads the file, changes it and writes it back, so a read that answered
    // "no sites" would persist that emptiness over every saved site and orphan their tokens.
    await assertSiteFileWritable()
    await ensureOrcaDir()
    const path = getSiteFilePath()
    const next = await selectableSiteFile(file)
    // Why the durable helper: a crash mid-write left truncated JSON, which the next launch read as "no
    // sites" and the next save then persisted.
    await writeFileDurable(durableWriteTempPath(path), path, JSON.stringify(next, null, 2), 0o600)
    siteFileCache.invalidate()
  })
}

export async function readToken(siteId: string): Promise<string | null> {
  return tokenFileCache.read(siteId)
}

/** How a site's stored token sits on disk, or null when none is stored. */
export async function getSiteTokenProtection(
  siteId: string
): Promise<SecretAtRestProtection | null> {
  return readCredentialFileProtection(getTokenPath(siteId))
}

export async function saveToken(siteId: string, apiToken: string): Promise<void> {
  return inCredentialFileOrder(`${getTokenPath(siteId)}.mutation`, async () => {
    await ensureOrcaDir()
    await ensureTokenDir()
    await writeEncryptedCredential('Jira', getTokenPath(siteId), apiToken)
    // The next action reads the actual file, including any overlapping writer's replacement.
    tokenFileCache.forget(siteId)
  })
}

export async function deleteToken(siteId: string): Promise<void> {
  return inCredentialFileOrder(`${getTokenPath(siteId)}.mutation`, async () => {
    tokenFileCache.forget(siteId)
    try {
      await unlink(getTokenPath(siteId))
    } catch {}
  })
}

export function inSiteRegistryOrder<T>(run: () => Promise<T>): Promise<T> {
  return inCredentialFileOrder(`${getSiteFilePath()}.registry`, run)
}
