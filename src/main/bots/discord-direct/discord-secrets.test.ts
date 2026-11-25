import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { _resetSecretStoreForTests } from '../../../shared/secure-storage/secret-store'
import { installFakeSealingStore } from '../tool-relay/bot-tool-relay.test-fixtures'
import { readDiscordToken, removeDiscordToken, writeDiscordToken } from './discord-secrets'
import { removeDiscordBot, writeDiscordBot } from './discord-store'
import { discordSecretsPath } from './discord-store-paths'

const TOKEN = 'MTIzNDU2Nzg5.DiscordBot.TOKEN-UNDER-TEST'
let userDataPath: string
beforeEach(async () => {
  userDataPath = await mkdtemp(join(tmpdir(), 'orca-discord-secrets-'))
})
afterEach(async () => {
  _resetSecretStoreForTests()
  await rm(userDataPath, { recursive: true, force: true })
})

const secretsFile = async (): Promise<string> => readFile(discordSecretsPath(userDataPath), 'utf-8')

describe('keeping a bot token', () => {
  it('stores a sealed token and reads it back, with no plaintext on disk', async () => {
    installFakeSealingStore()

    expect(await writeDiscordToken(userDataPath, 'bot-1', TOKEN)).toEqual({ ok: true })
    expect(await readDiscordToken(userDataPath, 'bot-1')).toBe(TOKEN)
    expect(await secretsFile()).not.toContain(TOKEN)
  })

  it('refuses on a host that cannot seal, and writes nothing', async () => {
    _resetSecretStoreForTests()

    const refused = await writeDiscordToken(userDataPath, 'bot-1', TOKEN)

    expect(refused).toEqual({
      ok: false,
      reason: 'cannot-seal',
      message:
        'This computer cannot seal a secret, so Orca will not write the Discord token to disk. Paste it again after a restart.'
    })
    expect(await readDiscordToken(userDataPath, 'bot-1')).toBeUndefined()
    await expect(secretsFile()).rejects.toThrow(/ENOENT/)
  })

  it('drops the token when the bot goes, and answers undefined for one it never had', async () => {
    installFakeSealingStore()
    await writeDiscordBot(userDataPath, {
      botId: 'bot-1',
      applicationId: 'app-1',
      botUserId: 'user-1',
      username: 'orca'
    })
    await writeDiscordToken(userDataPath, 'bot-1', TOKEN)

    expect(await readDiscordToken(userDataPath, 'bot-2')).toBeUndefined()

    await removeDiscordBot(userDataPath, 'bot-1')

    expect(await readDiscordToken(userDataPath, 'bot-1')).toBeUndefined()
    expect(await secretsFile()).toContain('"tokens": {}')
  })

  it('drops one token without touching another bot’s', async () => {
    installFakeSealingStore()
    await writeDiscordToken(userDataPath, 'bot-1', TOKEN)
    await writeDiscordToken(userDataPath, 'bot-2', 'second-token')

    await removeDiscordToken(userDataPath, 'bot-1')

    expect(await readDiscordToken(userDataPath, 'bot-1')).toBeUndefined()
    expect(await readDiscordToken(userDataPath, 'bot-2')).toBe('second-token')
    expect(await secretsFile()).not.toContain(TOKEN)
  })
})
