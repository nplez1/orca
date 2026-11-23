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
import { photonCanSealSecrets } from './photon-secrets'
import { PhotonStore } from './photon-store'
import { PhotonStreams } from './photon-streams'
import { PhotonTeardown } from './photon-teardown'
import { PhotonThreadMap } from './photon-thread-map'

/** Whoever a channel was built for: the runtime does, and a reply hook only has a bot roster. */
type PhotonChannelOwner = OrcaRuntimeService | { readonly bots?: unknown }

const channels = new WeakMap<PhotonChannelOwner, PhotonService>()

/** The channel built for this owner, or null when nothing built one.
 *  Lookup only: the full service needs the whole runtime, so it is built once where that exists, and every
 *  later caller asks for the instance rather than constructing a second set of stores. */
export function photonServiceOf(owner: PhotonChannelOwner): PhotonService | null {
  return channels.get(owner) ?? null
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
  const inbound = new PhotonInbound({
    inbox,
    cursors,
    threads,
    people: (botId) => built.people(botId),
    paused: (botId) => runtime.bots.list().find((entry) => entry.id === botId)?.paused === true,
    // Straight to the store: these are records about a bot, not channel state, and they are needed
    // before the service exists.
    noteUnknownSender: (botId) => store.noteUnknownSender(botId),
    noteParkedMessage: (botId, reason) => store.noteParkedMessage(botId, reason),
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
    sendToChat: async ({ botId, chatId, text, person }) => {
      // Who the conversation acts for is recorded per conversation, so a follow-up from someone other
      // than the person who opened it says *they* are asking rather than inheriting the opener's
      // authority.
      runtime.getOrchestrationDb().recordBotConversationActsFor(chatId, { actsFor: [person] })
      const delivered = await runtimeBotChats(runtime).sendToSession(botId, chatId, text)
      // A refused or rejected delivery is not a delivery. Marking it handled and advancing the cursor
      // would lose the owner's message silently, which is the opposite of what this channel promises.
      if (delivered.outcome.kind === 'refused') {
        throw new Error(delivered.outcome.refusal.message)
      }
      if (
        delivered.outcome.kind === 'sent' &&
        delivered.outcome.submission?.dispatchState === 'rejected'
      ) {
        throw new Error(
          delivered.outcome.submission.reason ?? "The bot's chat did not take the prompt."
        )
      }
    }
  })

  const sendPath = new PhotonSendPath({
    api,
    outbox,
    threads,
    noteUndelivered: (botId, reason) => store.noteUndeliveredAnswer(botId, reason)
  })
  const streams = new PhotonStreams({
    store,
    cursors,
    inbound,
    sendPath,
    io: socketFactory,
    setTimer: (callback, ms) => {
      const handle = setTimeout(callback, ms)
      return { cancel: () => clearTimeout(handle) }
    }
  })
  // Assigned once the service exists; the adapters below only read it when a frame arrives.
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
    sendPath,
    streams
  })
  channels.set(runtime, built)
  return built
}

/** What `orca bot connectors` says about one bot's channel, or null when the channel has no complete
 *  number for it. A bot provisioned only through its project and key is not connected: it has no number,
 *  so nobody can text it. */
export async function photonConnectorRow(
  store: PhotonStore,
  botId: string
): Promise<{ phoneNumber: string | null; handles: string[] } | null> {
  const record = await store.bot(botId)
  if (!record || record.released || record.completedThrough !== 'assignment') {
    return null
  }
  return {
    phoneNumber: record.phoneNumber ?? null,
    handles: record.assignments.map((entry) => entry.handle)
  }
}

/** What a settings card or `orca bot connectors` shows, without opening a stream to find out. */
export async function photonChannelStatus(
  service: PhotonService,
  botIds: readonly string[]
): Promise<PhotonChannelStatus> {
  const store = service.store()
  const account = await store.account()
  const credential = await store.accountCredential()
  return {
    connected: account !== null && credential !== null,
    organizationId: account?.organizationId ?? null,
    accountKeyStored: account?.storesKey === true,
    accountKeySealed: photonCanSealSecrets(),
    bots: (await store.bots()).map((record) => {
      const status = botIds.includes(record.botId) ? service.streamStatus(record.botId) : null
      return {
        botId: record.botId,
        slug: record.slug,
        projectId: record.projectId,
        phoneNumber: record.phoneNumber ?? null,
        handles: record.assignments.map((entry) => entry.handle),
        stream: streamWord(status, record.released),
        released: record.released,
        unknownSenderCount: record.unknownSenderCount,
        parkedMessageCount: record.parkedMessageCount,
        lastParkedReason: record.lastParkedReason ?? null,
        undeliveredAnswerCount: record.undeliveredAnswerCount,
        lastUndeliveredReason: record.lastUndeliveredReason ?? null
      }
    })
  }
}

function streamWord(
  status: ReturnType<PhotonService['streamStatus']>,
  released: boolean
): 'live' | 'deaf' | 'stopped' | 'not started' | 'released' {
  if (released) {
    return 'released'
  }
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
