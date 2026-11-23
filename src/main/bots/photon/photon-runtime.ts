// Building the channel's service for a runtime: the stores under this profile's user data, the client and
// stream, and the ask plumbing it borrows rather than reimplements. A bot's message becomes a turn
// through `startBotSession` and the bot's own chats, which is the same path an automation run uses — this
// is a channel adapter, not a second bot runtime.
import { randomUUID } from 'node:crypto'
import { io } from 'socket.io-client'
import type { Bot } from '../../../shared/bot-types'
import type { BotRequestPerson } from '../../../shared/bots/bot-acts-for'
import type { PhotonChannelStatus } from '../../../shared/rpc-contract/bots-photon-params'
import { getAppEnvironment } from '../../../shared/app-lifecycle/app-environment'
import { runtimeBotChats, startBotSession } from '../bot-chat-session'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { PhotonApi } from './photon-api'
import { PhotonCursorStore } from './photon-cursor'
import { PhotonInbound } from './photon-inbound'
import { PhotonInbox } from './photon-inbox'
import { PhotonOutbox } from './photon-outbox'
import { PhotonProvisioner } from './photon-provisioning'
import { PhotonSendPath } from './photon-send'
import { PhotonService } from './photon-service'
import type { PhotonIoFactory } from './photon-stream'
import { PhotonStore } from './photon-store'
import { PhotonTeardown } from './photon-teardown'
import { PhotonThreadMap } from './photon-thread-map'

const channels = new WeakMap<object, PhotonService>()

/** The channel built for this runtime, or null when nothing built one.
 *  Lookup only: the full service needs the whole runtime, so it is built once where that exists, and every
 *  later caller asks for the instance rather than constructing a second set of stores. */
export function photonServiceOf(runtime: object): PhotonService | null {
  return channels.get(runtime) ?? null
}

/** Socket.IO's own factory, narrowed to the slice the stream drives. */
const socketFactory: PhotonIoFactory = (url, options) => io(url, options)

function requireBot(runtime: OrcaRuntimeService, botId: string): Bot {
  const bot = runtime.bots.list().find((entry) => entry.id === botId)
  if (!bot) {
    throw new Error('That bot is gone.')
  }
  return bot
}

/** The service for a runtime, built once: its stores are file-backed and its streams long-lived. */
export function photonChannel(runtime: OrcaRuntimeService): PhotonService {
  const existing = photonServiceOf(runtime)
  if (existing) {
    return existing
  }
  const store = new PhotonStore(getAppEnvironment().getPath('userData'))
  const inbox = new PhotonInbox(store)
  const cursors = new PhotonCursorStore(store)
  const threads = new PhotonThreadMap(store)
  const outbox = new PhotonOutbox(store)
  const api = new PhotonApi()
  // Resolved lazily: the inbound adapter is built with the service, so it cannot close over it yet.
  let service: PhotonService | null = null

  const inbound = new PhotonInbound({
    inbox,
    cursors,
    threads,
    people: (botId) => {
      if (!service) {
        throw new Error('photon service used before it was built')
      }
      return service.people(botId)
    },
    startConversation: async ({ botId, text, person, title }) => {
      const bot = requireBot(runtime, botId)
      const sessionId = await startBotSession(runtime, bot, {
        message: { text, clientMessageId: randomUUID() },
        background: true,
        actsFor: { actsFor: [person] }
      })
      // The prompt is already in: a failed rename must not disown the conversation.
      await getStructuredAgentSessionHost()
        ?.setUserConversationName(sessionId, title, 'rename')
        .catch((error: unknown) => console.warn('[photon] could not name a conversation', error))
      return { chatId: sessionId }
    },
    sendToChat: async ({ botId, chatId, text }) => {
      await runtimeBotChats(runtime).sendToSession(botId, chatId, text)
    }
  })

  const built = new PhotonService({
    store,
    api,
    inbox,
    cursors,
    threads,
    outbox,
    provisioner: new PhotonProvisioner({ api, store }),
    teardown: new PhotonTeardown({ api, store }),
    inbound,
    sendPath: new PhotonSendPath({ api, outbox, threads }),
    io: socketFactory
  })
  service = built
  channels.set(runtime, built)
  return built
}

/** What a settings card or `orca bot connectors` shows, without opening a stream to find out. */
export function photonChannelStatus(
  service: PhotonService,
  store: PhotonStore,
  botIds: readonly string[]
): PhotonChannelStatus {
  const account = store.account()
  return {
    connected: account !== null && store.accountCredential() !== null,
    organizationId: account?.organizationId ?? null,
    accountKeyStored: account?.storesKey === true,
    bots: store.bots().map((record) => {
      const status = botIds.includes(record.botId) ? service.streamStatus(record.botId) : null
      return {
        botId: record.botId,
        slug: record.slug,
        projectId: record.projectId,
        phoneNumber: record.phoneNumber ?? null,
        handles: record.assignments.map((entry) => entry.handle),
        stream: streamWord(status)
      }
    })
  }
}

function streamWord(
  status: ReturnType<PhotonService['streamStatus']>
): 'live' | 'deaf' | 'stopped' | 'not started' {
  if (!status) {
    return 'not started'
  }
  if (status.state === 'stopped') {
    return 'stopped'
  }
  // Connected but never subscribed is deaf, and saying "live" here would be the lie this channel is
  // most vulnerable to.
  return status.subscribed ? 'live' : 'deaf'
}

export type PhotonAskPerson = BotRequestPerson
