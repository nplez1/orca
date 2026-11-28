// An existing Spectrum project's own channel: one `Spectrum()` instance per bot, streaming locally into
// the same inbound handler the Socket.IO stream feeds, and sending through the same outbox. Nothing here
// creates a project, mints a key or assigns a number — the owner's dashboard already did all three — so
// this path has no saga, no reconciler and no cursor to resume: the SDK redelivers nothing.
//
// The SDK is behind the narrow interface below on purpose. A test drives a channel with a hand-written
// iterable and no network, and the real `spectrum-ts` is imported only when a channel actually starts, so
// a profile that never connects one never loads it.
import type { PhotonInboundMessage } from './photon-contract'

/** The space a message arrived in, narrowed to what this channel reads: it is the conversation id, and
 *  the handle a reply is addressed to. */
export type SpectrumSpace = { readonly id: string }

/** One SDK message, narrowed to the fields the inbound shape needs. */
export type SpectrumMessage = {
  readonly id: string
  readonly direction: 'inbound' | 'outbound'
  /** Absent on a message the platform could not attribute to anyone. */
  readonly sender: { readonly id: string; readonly kind?: 'agent' } | undefined
  readonly content: { readonly type: string; readonly text?: string; readonly markdown?: string }
  readonly timestamp: Date
}

/** The slice of `spectrum-ts` this channel drives. */
export type SpectrumApp = {
  readonly messages: AsyncIterable<[SpectrumSpace, SpectrumMessage]>
  send(space: SpectrumSpace, content: string): Promise<unknown>
  /**
   * The provider's own lookup by id — `provider.space.get(id)` in spectrum-ts 12.16.0. It exists, so a
   * reply to a message replayed from the inbox after a restart resolves its space instead of being
   * refused; absent only in a test that does not model it, which keeps the refusal coverable.
   */
  space?(id: string): Promise<SpectrumSpace>
  stop(): Promise<void>
}

/** Opens the SDK for one project's pair. Injected so a test never imports it. */
export type SpectrumAppFactory = (credentials: {
  projectId: string
  projectSecret: string
}) => Promise<SpectrumApp>

/**
 * The real factory. `telemetry: false` because Orca is not a telemetry client of the owner's project, and
 * the iMessage provider is the only platform this channel speaks for: a project with others enabled
 * simply streams nothing this module can act on.
 */
export const photonSpectrumApp: SpectrumAppFactory = async ({ projectId, projectSecret }) => {
  const { Spectrum } = await import('spectrum-ts')
  const { imessage } = await import('spectrum-ts/providers/imessage')
  const spectrum = await Spectrum({
    projectId,
    projectSecret,
    providers: [imessage.config()],
    telemetry: false
  })
  // The provider instance is where a space can be built from a persisted id: `space` is a provider
  // namespace on the instance, not on the Spectrum object itself, which is why the line is resolved here.
  // The object it answers is the same one `send` takes, so the instance keeps its own send.
  const line = imessage(spectrum)
  return Object.assign(spectrum, { space: (id: string) => line.space.get(id) })
}

/**
 * One SDK message as the inbound handler's shape, or null when it is nothing to answer.
 *
 * Three skips, each for its own reason: a message the bot itself sent streams back to it and answering
 * would be the bot talking to itself; a sender-less message names nobody, so there is no person to
 * attribute the ask to and no handle to reply to; and a message with no text is an attachment or a
 * reaction, which this channel cannot hand a bot as a prompt — an empty ask would open a chat with no
 * question in it.
 */
export function spectrumInboundMessage(
  space: SpectrumSpace,
  message: SpectrumMessage
): PhotonInboundMessage | null {
  if (message.direction !== 'inbound') {
    return null
  }
  const sender = message.sender
  if (!sender || sender.kind === 'agent') {
    return null
  }
  const text = message.content.type === 'markdown' ? message.content.markdown : message.content.text
  if (text === undefined || text.trim().length === 0) {
    return null
  }
  return {
    id: message.id,
    conversationId: space.id,
    sender: { handle: sender.id },
    text,
    createdAt: message.timestamp.getTime()
  }
}

export type PhotonSpectrumChannelDeps = {
  botId: string
  projectId: string
  app: SpectrumApp
  /** The position this channel numbers its messages at, since Spectrum's stream has none. The inbound
   *  handler records it so a crash between the write and the dispatch can be replayed in order. */
  startSeq: number
  /** The inbound handler, which is the one the Socket.IO stream feeds: one pipeline, not two. */
  onMessage: (message: PhotonInboundMessage, seq: number) => Promise<void>
  log?: (message: string, ...rest: unknown[]) => void
}

export class PhotonSpectrumChannel {
  private readonly log: (message: string, ...rest: unknown[]) => void
  /** The space each conversation arrived in. The SDK sends to the space object it streamed, so a reply to
   *  a conversation this run has seen is addressed through this map; one it has not is resolved from the
   *  SDK by id, which the provider namespace offers (`space.get`). */
  private readonly spaces = new Map<string, SpectrumSpace>()
  private seq: number
  private state: 'starting' | 'live' | 'stopped' = 'stopped'

  constructor(private readonly deps: PhotonSpectrumChannelDeps) {
    this.log = deps.log ?? ((message, ...rest) => console.warn(message, ...rest))
    this.seq = deps.startSeq
  }

  get live(): boolean {
    return this.state === 'live'
  }

  /** Starts reading, once. The loop owns its own failures: a stream that ends leaves the channel stopped,
   *  and the health tick the stream loop owns — which ticks this registry too — is what starts a new one. */
  start(): void {
    if (this.state !== 'stopped') {
      return
    }
    this.state = 'live'
    void this.read()
  }

  /**
   * Sends one message to one of this channel's conversations. It replies through the space the conversation
   * arrived in, and — for a message replayed from the inbox after a restart, whose space this run never
   * streamed — through the provider's lookup by id. A lookup that fails is refused rather than guessed at,
   * so the answer waits in the outbox instead of being sent to nothing.
   */
  async send(conversationId: string, text: string): Promise<void> {
    const space = this.spaces.get(conversationId) ?? (await this.spaceFor(conversationId))
    if (!space) {
      throw new Error(
        `Orca has no live Spectrum space for conversation ${conversationId}, so this answer waits: a reply goes to the space the conversation arrived in, and this run could not resolve one for its id.`
      )
    }
    await this.deps.app.send(space, text)
  }

  /** A space built from a persisted conversation id, remembered so the next reply needs no lookup. */
  private async spaceFor(conversationId: string): Promise<SpectrumSpace | null> {
    const lookup = this.deps.app.space
    if (!lookup) {
      return null
    }
    try {
      const space = await lookup(conversationId)
      this.spaces.set(conversationId, space)
      return space
    } catch (error) {
      this.log('[photon] could not resolve a Spectrum space by id', error)
      return null
    }
  }

  /** Stops reading and closes the stream. The SDK's own `stop` is what ends the iteration. */
  stop(): void {
    this.state = 'stopped'
    void this.deps.app.stop().catch((error: unknown) => {
      this.log('[photon] could not close a Spectrum stream cleanly', error)
    })
  }

  private async read(): Promise<void> {
    try {
      for await (const [space, message] of this.deps.app.messages) {
        if (this.state === 'stopped') {
          return
        }
        this.spaces.set(space.id, space)
        const inbound = spectrumInboundMessage(space, message)
        if (!inbound) {
          continue
        }
        this.seq += 1
        try {
          await this.deps.onMessage(inbound, this.seq)
        } catch (error) {
          // A message Orca could not dispatch stays in the inbox unhandled, and the recovery replays it;
          // ending the stream over one would stop every later message too.
          this.log('[photon] could not hand a Spectrum message to Orca', error)
        }
      }
    } catch (error) {
      this.log('[photon] a Spectrum stream ended with an error', error)
    } finally {
      if (this.state === 'live') {
        this.state = 'stopped'
        this.log(
          '[photon] a Spectrum stream ended for bot',
          this.deps.botId,
          'on project',
          this.deps.projectId
        )
      }
    }
  }
}
