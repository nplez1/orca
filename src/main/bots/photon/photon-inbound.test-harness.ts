// The stores and the two seams an inbound test drives, built over one temp profile. Shared so the
// ordering tests and the recovery tests describe the same world.
import type { BotRequestPerson } from '../../../shared/bots/bot-acts-for'
import { PhotonCursorStore } from './photon-cursor'
import { PhotonInbound, type PhotonPerson } from './photon-inbound'
import { PhotonInbox } from './photon-inbox'
import { PhotonStore } from './photon-store'
import { PhotonThreadMap } from './photon-thread-map'

export type Call = {
  kind: 'start' | 'send'
  chatId?: string
  text: string
  person: BotRequestPerson
}

/** A gate the harness holds a dispatch at, and the moment it arrived there: ordering assertions wait on
 *  `began`, never on a timer. */
export function startGate(): {
  begin: () => Promise<void>
  release: () => void
  began: Promise<void>
} {
  let release = (): void => {}
  let began = (): void => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  const started = new Promise<void>((resolve) => (began = resolve))
  return {
    begin: () => {
      began()
      return held
    },
    release: () => release(),
    began: started
  }
}

export type HarnessOptions = {
  people?: Map<string, PhotonPerson>
  failStart?: boolean
  failStartFor?: string
  holdStart?: () => Promise<void>
  paused?: boolean
  refusedSend?: string
  /** A follow-up that fails the way a deleted or retired chat's does, every time. */
  failSend?: boolean
  /** The clock the inbox judges its retry horizon by. */
  now?: () => number
}

export function inboundHarness(userDataPath: string, options: HarnessOptions = {}) {
  const store = new PhotonStore(userDataPath)
  const inbox = new PhotonInbox(store, options.now)
  const cursors = new PhotonCursorStore(store)
  const threads = new PhotonThreadMap(store)
  const calls: Call[] = []
  const unknownSenders: string[] = []
  const parked: string[] = []
  let chats = 0
  const inbound = new PhotonInbound({
    inbox,
    cursors,
    threads,
    people: async () =>
      options.people ?? new Map([['+15551230000', { name: 'Sam', role: 'owner' }]]),
    paused: () => options.paused === true,
    noteUnknownSender: (botId) => {
      unknownSenders.push(botId)
    },
    noteParkedMessage: (_botId, reason) => {
      parked.push(reason)
    },
    startConversation: async ({ text, person }) => {
      if (options.holdStart) {
        await options.holdStart()
      }
      if (options.failStart || options.failStartFor === text) {
        throw new Error('the chat would not start')
      }
      chats += 1
      calls.push({ kind: 'start', text, person })
      return { chatId: `chat_${chats}` }
    },
    sendToChat: async ({ chatId, text, person }) => {
      if (options.refusedSend) {
        throw new Error(options.refusedSend)
      }
      if (options.failSend) {
        throw new Error('This chat is closed.')
      }
      calls.push({ kind: 'send', chatId, text, person })
    },
    log: () => {}
  })
  return { inbound, calls, inbox, cursors, threads, store, unknownSenders, parked }
}
