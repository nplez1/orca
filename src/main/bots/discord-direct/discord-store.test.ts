import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  readDiscordStore,
  recordUnknownSender,
  removeDiscordBot,
  setAnswerInServers,
  setTokenState,
  writeDiscordBot
} from './discord-store'
import { discordRecordPath } from './discord-store-paths'

let userDataPath: string
beforeEach(async () => {
  userDataPath = await mkdtemp(join(tmpdir(), 'orca-discord-store-'))
})
afterEach(async () => {
  await rm(userDataPath, { recursive: true, force: true })
})

const bot = (botId: string) => ({
  botId,
  applicationId: `app-${botId}`,
  botUserId: `user-${botId}`,
  username: `orca-${botId}`
})

const stored = async (): Promise<{ schemaVersion: number; bots: unknown[] }> =>
  JSON.parse(await readFile(discordRecordPath(userDataPath), 'utf-8'))

describe('the bot record', () => {
  it('round trips one bot with its defaults', async () => {
    const written = await writeDiscordBot(userDataPath, bot('1'))
    expect(written).toMatchObject({
      botId: '1',
      applicationId: 'app-1',
      botUserId: 'user-1',
      username: 'orca-1',
      tokenState: 'ok',
      answerInServers: false,
      unknownSenders: []
    })
    expect(await readDiscordStore(userDataPath)).toEqual([written])
    expect((await stored()).schemaVersion).toBe(1)
  })

  it('keeps a record this build cannot parse, byte for byte, through a rewrite', async () => {
    const future = { botId: 'future-bot', answerMode: 'always', scopes: ['dm'] }
    await mkdir(dirname(discordRecordPath(userDataPath)), { recursive: true })
    await writeFile(
      discordRecordPath(userDataPath),
      JSON.stringify({ schemaVersion: 1, bots: [future] })
    )

    const written = await writeDiscordBot(userDataPath, bot('1'))

    expect((await stored()).bots).toEqual([future, written])
    expect(await readDiscordStore(userDataPath)).toEqual([written])
  })

  it('keeps the settings a token re-paste did not mention', async () => {
    await writeDiscordBot(userDataPath, bot('1'))
    await setAnswerInServers(userDataPath, '1', true)
    await setTokenState(userDataPath, '1', 'invalid')

    const again = await writeDiscordBot(userDataPath, { ...bot('1'), username: 'orca-renamed' })

    expect(again.username).toBe('orca-renamed')
    expect(again.answerInServers).toBe(true)
    expect(again.tokenState).toBe('invalid')
  })

  it('drops a bot on removal and answers null for one that is not there', async () => {
    await writeDiscordBot(userDataPath, bot('1'))
    await writeDiscordBot(userDataPath, bot('2'))

    await removeDiscordBot(userDataPath, '1')

    expect((await readDiscordStore(userDataPath)).map((record) => record.botId)).toEqual(['2'])
    expect(await setAnswerInServers(userDataPath, '1', true)).toBeNull()
  })

  it('keeps the ten newest unknown senders, newest first and once each', async () => {
    await writeDiscordBot(userDataPath, bot('1'))
    for (let index = 0; index < 12; index += 1) {
      await recordUnknownSender(userDataPath, '1', {
        userId: `u${index}`,
        username: `user-${index}`
      })
    }

    const capped = await recordUnknownSender(userDataPath, '1', {
      userId: 'u5',
      username: 'user-5-renamed'
    })

    expect(capped?.unknownSenders).toEqual([
      { userId: 'u5', username: 'user-5-renamed' },
      { userId: 'u11', username: 'user-11' },
      { userId: 'u10', username: 'user-10' },
      { userId: 'u9', username: 'user-9' },
      { userId: 'u8', username: 'user-8' },
      { userId: 'u7', username: 'user-7' },
      { userId: 'u6', username: 'user-6' },
      { userId: 'u4', username: 'user-4' },
      { userId: 'u3', username: 'user-3' },
      { userId: 'u2', username: 'user-2' }
    ])
  })
})
