// The connected GitHub App as stored on this computer: its id, its key, and the installations it can act
// in. The key is sealed by the OS keyring, so a copy of this file is not a copy of the key.
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
import { getSecretStore, hasSecretStore } from '../../../shared/secure-storage/secret-store'
import { writeSecureFileAsync } from '../../../shared/secure-storage/secure-file-async-write'
import { githubAppBotLogin } from '../../../shared/github/app/github-app-identity'
import { getCanonicalUserDataPath } from '../../persistence/loading-store/user-data-path'

/** Sealed only: Orca never writes a key in the clear, so an envelope it cannot unseal is not one of ours. */
const Envelope = lazyZodSchema(() => z.string().regex(/^sealed:[A-Za-z0-9+/=]*$/))

const Installation = lazyZodSchema(() =>
  z.object({
    id: z.number().int().positive(),
    /** The account the App is installed on, for display. */
    account: z.string().min(1),
    repositorySelection: z.enum(['all', 'selected']),
    /** `owner/name`, lowercase-compared when checked against a repo. */
    repositories: z.array(z.string().min(1)),
    /** Contents: write, which a push needs; null when GitHub did not report the installation's permissions. */
    contentsWrite: z.boolean().nullish(),
    /** Workflows: write, which a push that touches .github/workflows needs; null when not reported. */
    workflowsWrite: z.boolean().nullish()
  })
)

const Stored = lazyZodSchema(() =>
  z.object({
    version: z.literal(1),
    appId: z.number().int().positive(),
    /** The App's slug, from which its login follows: `<slug>[bot]`. */
    slug: z.string().min(1),
    privateKey: Envelope,
    installations: z.array(Installation)
  })
)

export type GithubAppInstallation = z.infer<typeof Installation>
export type GithubAppCredentials = {
  appId: number
  slug: string
  privateKeyPem: string
  installations: readonly GithubAppInstallation[]
}

export function githubAppLogin(slug: string): string {
  return githubAppBotLogin(slug)
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
  const [, payload = ''] = envelope.split(':', 2)
  assertCanSeal()
  return getSecretStore().decryptString(Buffer.from(payload, 'base64'))
}

const UNREADABLE = 'github-app: the stored App credentials are not readable; connect the App again'

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
  // A parse failure names a slice of the sealed ciphertext; the detail belongs in the log, not in a message.
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    console.warn('[github-app] the stored App credentials did not parse', error)
    throw new Error(UNREADABLE)
  }
  const stored = Stored.safeParse(parsed)
  if (!stored.success) {
    throw new Error(UNREADABLE)
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

export async function removeGithubAppCredentials(): Promise<void> {
  await rm(githubAppCredentialsPath(), { force: true })
}
