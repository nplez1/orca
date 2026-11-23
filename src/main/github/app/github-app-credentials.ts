// The connected GitHub App as stored on this computer: its id, its key, and the installations it can act
// in. The key is sealed by the OS keyring, so a copy of this file is not a copy of the key.
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { getSecretStore, hasSecretStore } from '../../../shared/secure-storage/secret-store'
import { writeSecureFileAsync } from '../../../shared/secure-storage/secure-file-async-write'
import { isGithubAppBotLogin } from '../../../shared/github/app/github-app-identity'
import { getCanonicalUserDataPath } from '../../persistence/loading-store/user-data-path'

const Envelope = z.string().regex(/^(?:sealed|plain):[A-Za-z0-9+/=]*$/)

const Installation = z.object({
  id: z.number().int().positive(),
  /** The account the App is installed on, for display. */
  account: z.string().min(1),
  repositorySelection: z.enum(['all', 'selected']),
  /** `owner/name`, lowercase-compared when checked against a repo. */
  repositories: z.array(z.string().min(1))
})

const Stored = z.object({
  version: z.literal(1),
  appId: z.number().int().positive(),
  /** The App's slug, from which its login follows: `<slug>[bot]`. */
  slug: z.string().min(1),
  privateKey: Envelope,
  installations: z.array(Installation)
})

export type GithubAppInstallation = z.infer<typeof Installation>
export type GithubAppCredentials = {
  appId: number
  slug: string
  privateKeyPem: string
  installations: readonly GithubAppInstallation[]
}

/** The App's login. Derived rather than stored, so a renamed App is not two identities. */
export function githubAppLogin(slug: string): string {
  const login = `${slug.trim()}[bot]`
  if (!isGithubAppBotLogin(login)) {
    throw new Error('github-app: the app slug cannot be empty')
  }
  return login
}

export function githubAppCredentialsPath(): string {
  return join(getCanonicalUserDataPath(), 'github-app.json')
}

/** Sealing is the whole protection for the key on disk, so a host without one cannot store an App. */
function assertCanSeal(): void {
  if (!hasSecretStore() || !getSecretStore().isEncryptionAvailable()) {
    throw new Error(
      'Orca can’t lock a GitHub App key on this computer because it has no system keyring, so it won’t store one.'
    )
  }
}

function seal(value: string): string {
  assertCanSeal()
  return `sealed:${getSecretStore().encryptString(value).toString('base64')}`
}

function unseal(envelope: string): string {
  const [kind, payload = ''] = envelope.split(':', 2)
  const bytes = Buffer.from(payload, 'base64')
  if (kind !== 'plain') {
    assertCanSeal()
    return getSecretStore().decryptString(bytes)
  }
  // A `plain:` envelope on a sealing host was not written by Orca: refuse rather than trust it.
  if (hasSecretStore() && getSecretStore().isEncryptionAvailable()) {
    throw new Error('github-app: refusing an unsealed key on a host that seals')
  }
  return bytes.toString('utf8')
}

/** The stored App, or null when none is connected. Throws when a file exists but does not parse. */
export async function readGithubAppCredentials(): Promise<GithubAppCredentials | null> {
  let text: string
  try {
    text = await readFile(githubAppCredentialsPath(), 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
  const parsed: unknown = JSON.parse(text)
  const stored = Stored.safeParse(parsed)
  if (!stored.success) {
    throw new Error(
      'github-app: the stored App credentials are not readable; connect the App again'
    )
  }
  return {
    appId: stored.data.appId,
    slug: stored.data.slug,
    privateKeyPem: unseal(stored.data.privateKey),
    installations: stored.data.installations
  }
}

export async function writeGithubAppCredentials(credentials: GithubAppCredentials): Promise<void> {
  const stored: z.infer<typeof Stored> = {
    version: 1,
    appId: credentials.appId,
    slug: credentials.slug,
    privateKey: seal(credentials.privateKeyPem),
    installations: [...credentials.installations]
  }
  const written = await writeSecureFileAsync(
    githubAppCredentialsPath(),
    `${JSON.stringify(stored, null, 2)}\n`,
    { durable: true }
  )
  if (!written) {
    throw new Error('github-app: the App credentials could not be written')
  }
}

/** Disconnecting must leave nothing behind: the file holds the only sealed copy of the key. */
export async function removeGithubAppCredentials(): Promise<void> {
  await rm(githubAppCredentialsPath(), { force: true })
}
