// The bot token, sealed through the host's secret store. Unlike Photon there is no plaintext fallback: a
// Discord token can send as the owner's bot, so a host that cannot seal is refused and told why, rather
// than degraded into a file anyone with the disk can read. Nothing here logs a token, and no function
// returns one that was not asked for by id.
import { z } from 'zod'
import { getSecretStore, hasSecretStore } from '../../../shared/secure-storage/secret-store'
import { readDiscordJson, serialiseByFile, writeDiscordJson } from './discord-files'
import { discordSecretsPath } from './discord-store-paths'

/** Whether this host can seal a token it is asked to keep; the setup copy and the status read it. */
export function discordCanSealSecrets(): boolean {
  try {
    return hasSecretStore() && getSecretStore().isEncryptionAvailable()
  } catch {
    return false
  }
}

/** A refused write, as a value rather than a throw: the caller shows the message and keeps the token for
 *  the session, which is a choice the owner can make. */
export type DiscordTokenRefusal = {
  ok: false
  reason: 'cannot-seal'
  message: string
}
export type DiscordTokenWrite = { ok: true } | DiscordTokenRefusal

const StoredSecretsSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  /** Per bot, keyed by bot id: only its own token, never another bot's, and only as a sealed blob. */
  tokens: z.record(z.string(), z.string().min(1)).default({})
})
type StoredSecrets = z.infer<typeof StoredSecretsSchema>

const emptySecrets = (): StoredSecrets => ({ schemaVersion: 1, tokens: {} })

/** A secrets file this build cannot read is not replaced: the tokens in it are still live. */
class DiscordSecretsUnreadableError extends Error {
  constructor(readonly path: string) {
    super(
      `Orca cannot read ${path}, so it will not overwrite it: that file holds sealed bot tokens. Move it aside to paste them again.`
    )
    this.name = 'DiscordSecretsUnreadableError'
  }
}

async function readSecrets(userDataPath: string): Promise<StoredSecrets> {
  const path = discordSecretsPath(userDataPath)
  const read = await readDiscordJson(path, 'secrets')
  if (read.kind === 'missing') {
    return emptySecrets()
  }
  if (read.kind === 'unreadable') {
    throw new DiscordSecretsUnreadableError(path)
  }
  const parsed = StoredSecretsSchema.safeParse(read.value)
  if (!parsed.success) {
    throw new DiscordSecretsUnreadableError(path)
  }
  return parsed.data
}

function change(userDataPath: string, mutate: (secrets: StoredSecrets) => boolean): Promise<void> {
  return serialiseByFile(discordSecretsPath(userDataPath), async () => {
    const secrets = await readSecrets(userDataPath)
    if (!mutate(secrets)) {
      return
    }
    await writeDiscordJson(discordSecretsPath(userDataPath), secrets)
  })
}

/** Keeps one bot's token, or refuses and says why. There is no path that writes the token in the clear. */
export async function writeDiscordToken(
  userDataPath: string,
  botId: string,
  token: string
): Promise<DiscordTokenWrite> {
  if (!discordCanSealSecrets()) {
    return {
      ok: false,
      reason: 'cannot-seal',
      message:
        'This computer cannot seal a secret, so Orca will not write the Discord token to disk. Paste it again after a restart.'
    }
  }
  const sealed = `sealed:${getSecretStore().encryptString(token).toString('base64')}`
  await change(userDataPath, (secrets) => {
    secrets.tokens = { ...secrets.tokens, [botId]: sealed }
    return true
  })
  return { ok: true }
}

/** One bot's token, or undefined when none is stored or this host cannot open it. A token that cannot be
 *  opened is a token to paste again, not a crash. */
export async function readDiscordToken(
  userDataPath: string,
  botId: string
): Promise<string | undefined> {
  let secrets: StoredSecrets
  try {
    secrets = await readSecrets(userDataPath)
  } catch {
    return undefined
  }
  const stored = secrets.tokens[botId]
  if (!stored) {
    return undefined
  }
  const [kind, payload = ''] = stored.split(':', 2)
  if (kind !== 'sealed') {
    return undefined
  }
  try {
    return getSecretStore().decryptString(Buffer.from(payload, 'base64'))
  } catch {
    console.warn('[discord] a stored token cannot be opened on this host')
    return undefined
  }
}

/** Drops one bot's token; a record without one is a bot that can never connect. */
export function removeDiscordToken(userDataPath: string, botId: string): Promise<void> {
  return change(userDataPath, (secrets) => {
    if (!(botId in secrets.tokens)) {
      return false
    }
    const { [botId]: _dropped, ...rest } = secrets.tokens
    secrets.tokens = rest
    return true
  }).catch((error: unknown) => {
    // Removing a bot must not fail on a secrets file it could not read in the first place; the token is
    // unreachable either way, and the file stays where the owner can inspect it.
    if (!(error instanceof DiscordSecretsUnreadableError)) {
      throw error
    }
  })
}
