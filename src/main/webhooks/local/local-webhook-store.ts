// This computer's webhooks, in a file of the fork's own: Orca Cloud's ledger holds the cloud's hooks
// and the changes it has yet to confirm, and a local hook has neither, so it lives beside it rather
// than inside a schema the cloud owns. A call's body is its own file, so a delivery touches one small
// file instead of rewriting everything this computer has kept. Every change goes through one queue, so
// two overlapping writes cannot each clone the same state and lose the other's. The writes are awaited
// off the main thread on POSIX; on win32 writeSecureFileAsync is synchronous throughout (see `write`).
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
import {
  WEBHOOK_CALL_ID_PATTERN,
  WEBHOOK_HOOK_ID_PATTERN
} from '../../../shared/connector-webhook-contract'
import { WebhookEnvelope } from '../../../shared/connector-webhook-routes'
import { writeSecureFileAsync } from '../../../shared/secure-storage/secure-file-async-write'
import { isMissingFileError } from '../../runtime/rpc/server/pairing/device-registry-corruption'

export const LOCAL_WEBHOOK_DIR = 'local-webhooks'
const STORE_FILE = 'local-webhooks.json'
const CALLS_DIR = 'calls'
/** A hook minted before its automation was saved is kept this long, as the cloud keeps a mint intent. */
export const LOCAL_MINT_GRACE_MS = 10 * 60 * 1000
/** Local hooks have no revocation generation: one token, until the rule goes. */
export const LOCAL_WEBHOOK_EPOCH = 1

const HookId = lazyZodSchema(() => z.string().regex(WEBHOOK_HOOK_ID_PATTERN))
const CallId = lazyZodSchema(() => z.string().regex(WEBHOOK_CALL_ID_PATTERN))

const LocalHook = lazyZodSchema(() =>
  z.object({
    hookId: HookId,
    token: z.string().min(16),
    automationId: z.string().min(1),
    botId: z.string().min(1),
    epoch: z.literal(LOCAL_WEBHOOK_EPOCH),
    created: z.number()
  })
)
export type LocalHook = z.infer<typeof LocalHook>

/** Where a call's body went; the body itself is beside it, in its own file. */
const LocalCall = lazyZodSchema(() =>
  z.object({
    callId: CallId,
    hookId: HookId,
    createdAt: z.number()
  })
)
export type LocalCall = z.infer<typeof LocalCall>

/** A hook minted for an automation that has not been saved yet, so a change in between cannot drop it. */
const LocalIntent = lazyZodSchema(() =>
  z.object({
    automationId: z.string().min(1),
    hookId: HookId,
    createdAt: z.number()
  })
)
export type LocalIntent = z.infer<typeof LocalIntent>

const StoredStore = lazyZodSchema(() =>
  z.object({
    hooks: z.array(LocalHook),
    calls: z.array(LocalCall),
    intents: z.array(LocalIntent).default([])
  })
)
type StoredStore = z.infer<typeof StoredStore>

const emptyStore = (): StoredStore => ({ hooks: [], calls: [], intents: [] })

/** A queued change: what it worked out, and whether the index has to be written for it. */
type Change<T> = { changed: boolean; value: T }

export class LocalWebhookStore {
  private stored: StoredStore | null = null
  private loading: Promise<void> | null = null
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly userDataPath: string) {}

  get path(): string {
    return join(this.userDataPath, LOCAL_WEBHOOK_DIR, STORE_FILE)
  }

  /** One call's body, owner-only, named by the id the ledger and the call file already know. */
  bodyPath(callId: string): string {
    return join(this.userDataPath, LOCAL_WEBHOOK_DIR, CALLS_DIR, `${callId}.json`)
  }

  /** Reads the index once; every reader after that is served from memory. */
  async load(): Promise<void> {
    this.loading ??= this.read()
    await this.loading
  }

  private async read(): Promise<void> {
    if (this.stored) {
      return
    }
    try {
      const parsed = StoredStore.safeParse(JSON.parse(await readFile(this.path, 'utf8')))
      if (parsed.success) {
        this.stored = parsed.data
        return
      }
    } catch (error) {
      if (!isMissingFileError(error)) {
        console.warn('[webhooks] this computer’s local webhooks were unreadable; starting empty')
      }
    }
    this.stored = emptyStore()
  }

  private async index(): Promise<StoredStore> {
    await this.load()
    return this.stored ?? emptyStore()
  }

  /**
   * One change at a time, each over the state the one before it left: two overlapping writes would
   * otherwise clone the same index and the last to finish would silently drop the other's row — a call
   * whose 200 was already sent, or a hook a change event had just dropped coming back to life.
   */
  private enqueue<T>(task: (draft: StoredStore) => Promise<Change<T>> | Change<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const draft = structuredClone(await this.index())
      const { changed, value } = await task(draft)
      if (changed) {
        await this.write(this.path, draft)
        this.stored = draft
      }
      return value
    })
    // The queue outlives a failed write, so one refusal does not wedge every later change.
    this.queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  /**
   * Staged, owner-only and durable: the one write this store does, so no caller can skip a step. Off the
   * thread on POSIX, where only the publishing rename is synchronous; on win32 the helper writes, chmods
   * and fsyncs synchronously, so a delivery there does two blocking durable writes.
   */
  private write(target: string, value: unknown): Promise<void> {
    return writeSecureFileAsync(target, JSON.stringify(value, null, 2), { durable: true }).then(
      () => undefined
    )
  }

  hooks(): readonly LocalHook[] {
    return this.stored?.hooks ?? []
  }

  hook(hookId: string): LocalHook | undefined {
    return this.hooks().find((entry) => entry.hookId === hookId)
  }

  calls(): readonly LocalCall[] {
    return this.stored?.calls ?? []
  }

  call(callId: string): LocalCall | undefined {
    return this.calls().find((entry) => entry.callId === callId)
  }

  /** A call's body, read back for the run that quotes it; undefined once its row is gone. */
  async envelope(callId: string): Promise<WebhookEnvelope | undefined> {
    await this.load()
    if (!this.call(callId)) {
      return undefined
    }
    try {
      const parsed = WebhookEnvelope.safeParse(
        JSON.parse(await readFile(this.bodyPath(callId), 'utf8'))
      )
      return parsed.success ? parsed.data : undefined
    } catch (error) {
      if (!isMissingFileError(error)) {
        console.warn('[webhooks] could not read a local call’s body', error)
      }
    }
    return undefined
  }

  putHook(hook: LocalHook): Promise<void> {
    return this.enqueue((draft) => {
      draft.hooks = [...draft.hooks.filter((entry) => entry.hookId !== hook.hookId), hook]
      return { changed: true, value: undefined }
    })
  }

  /** A hook, its pending mint and the calls still waiting for it: nothing can answer for them once it is gone. */
  async dropHook(hookId: string): Promise<void> {
    const dropped = await this.enqueue((draft) => {
      const going = draft.calls.filter((entry) => entry.hookId === hookId)
      draft.hooks = draft.hooks.filter((entry) => entry.hookId !== hookId)
      draft.intents = draft.intents.filter((entry) => entry.hookId !== hookId)
      draft.calls = draft.calls.filter((entry) => entry.hookId !== hookId)
      return { changed: true, value: going.map((entry) => entry.callId) }
    })
    await removeBodies(this, dropped)
  }

  /**
   * The body first, so a row never names a body that is not there. False when the hook went while the
   * body was being written: its call has nothing left to answer for.
   */
  putCall(call: LocalCall, envelope: WebhookEnvelope): Promise<boolean> {
    return this.enqueue(async (draft) => {
      if (!draft.hooks.some((entry) => entry.hookId === call.hookId)) {
        return { changed: false, value: false }
      }
      await this.write(this.bodyPath(call.callId), envelope)
      draft.calls = [...draft.calls.filter((entry) => entry.callId !== call.callId), call]
      return { changed: true, value: true }
    })
  }

  async dropCall(callId: string): Promise<void> {
    const dropped = await this.enqueue((draft) => {
      if (!draft.calls.some((entry) => entry.callId === callId)) {
        return { changed: false, value: false }
      }
      draft.calls = draft.calls.filter((entry) => entry.callId !== callId)
      return { changed: true, value: true }
    })
    if (dropped) {
      await removeBodies(this, [callId])
    }
  }

  intents(): readonly LocalIntent[] {
    return this.stored?.intents ?? []
  }

  /** A hook minted for an automation whose save has not landed yet. */
  saveIntent(intent: LocalIntent): Promise<void> {
    return this.enqueue((draft) => {
      draft.intents = [...draft.intents.filter((entry) => entry.hookId !== intent.hookId), intent]
      return { changed: true, value: undefined }
    })
  }

  dropIntent(hookId: string): Promise<void> {
    return this.enqueue((draft) => {
      if (!draft.intents.some((entry) => entry.hookId === hookId)) {
        return { changed: false, value: undefined }
      }
      draft.intents = draft.intents.filter((entry) => entry.hookId !== hookId)
      return { changed: true, value: undefined }
    })
  }

  /** Drops what nothing needs again: unlisted hooks, and bodies no ledger row owns. */
  async prune(
    keepHook: (hook: LocalHook) => boolean,
    keepCalls: ReadonlySet<string>
  ): Promise<void> {
    const gone = await this.enqueue((draft) => {
      const stale = draft.calls.filter((entry) => !keepCalls.has(entry.callId))
      const listed = draft.hooks.filter(keepHook)
      const unchanged = stale.length === 0 && listed.length === draft.hooks.length
      if (unchanged) {
        const none: string[] = []
        return { changed: false, value: none }
      }
      const kept = new Set(listed.map((hook) => hook.hookId))
      draft.hooks = listed
      draft.intents = draft.intents.filter((intent) => kept.has(intent.hookId))
      draft.calls = draft.calls.filter((entry) => keepCalls.has(entry.callId))
      return { changed: true, value: stale.map((entry) => entry.callId) }
    })
    await removeBodies(this, gone)
  }
}

async function removeBodies(store: LocalWebhookStore, callIds: readonly string[]): Promise<void> {
  for (const callId of callIds) {
    try {
      await rm(store.bodyPath(callId), { force: true })
    } catch (error) {
      console.warn('[webhooks] could not delete a local call’s body', error)
    }
  }
}
