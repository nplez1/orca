// This computer's webhooks, in a file of the fork's own: Orca Cloud's ledger holds the cloud's hooks
// and the changes it has yet to confirm, and a local hook has neither, so it lives beside it rather
// than inside a schema the cloud owns. A call's body is its own file, so a delivery touches one small
// file instead of rewriting everything this computer has kept. Every write is off the thread: this runs
// in the main process, on a loopback request's own path.
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
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

const HookId = z.string().regex(WEBHOOK_HOOK_ID_PATTERN)
const CallId = z.string().regex(WEBHOOK_CALL_ID_PATTERN)

const LocalHook = z.object({
  hookId: HookId,
  token: z.string().min(16),
  automationId: z.string().min(1),
  botId: z.string().min(1),
  epoch: z.literal(LOCAL_WEBHOOK_EPOCH),
  created: z.number()
})
export type LocalHook = z.infer<typeof LocalHook>

/** Where a call's body went; the body itself is beside it, in its own file. */
const LocalCall = z.object({
  callId: CallId,
  hookId: HookId,
  createdAt: z.number()
})
export type LocalCall = z.infer<typeof LocalCall>

/** A hook minted for an automation that has not been saved yet, so a change in between cannot drop it. */
const LocalIntent = z.object({
  automationId: z.string().min(1),
  hookId: HookId,
  createdAt: z.number()
})
export type LocalIntent = z.infer<typeof LocalIntent>

const StoredStore = z.object({
  hooks: z.array(LocalHook),
  calls: z.array(LocalCall),
  intents: z.array(LocalIntent).default([])
})
type StoredStore = z.infer<typeof StoredStore>

const emptyStore = (): StoredStore => ({ hooks: [], calls: [], intents: [] })

export class LocalWebhookStore {
  private stored: StoredStore | null = null
  private loading: Promise<void> | null = null

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
   * On disk before it is in memory, and before the caller answers: a hook or a call exists only once it
   * survives a crash, which is what lets the listener answer 200 for a call it has already kept.
   */
  private async commit(change: (store: StoredStore) => void): Promise<void> {
    const next = structuredClone(await this.index())
    change(next)
    await this.write(this.path, next)
    this.stored = next
  }

  /** Staged, owner-only and durable: the one write this store does, so no caller can skip a step. */
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
      return undefined
    }
  }

  async putHook(hook: LocalHook): Promise<void> {
    await this.commit((store) => {
      store.hooks = [...store.hooks.filter((entry) => entry.hookId !== hook.hookId), hook]
    })
  }

  /** A hook, its pending mint and the calls still waiting for it: nothing can answer for them once it is gone. */
  async dropHook(hookId: string): Promise<void> {
    const dropped = this.calls().filter((entry) => entry.hookId === hookId)
    await this.commit((store) => {
      store.hooks = store.hooks.filter((entry) => entry.hookId !== hookId)
      store.intents = store.intents.filter((entry) => entry.hookId !== hookId)
      store.calls = store.calls.filter((entry) => entry.hookId !== hookId)
    })
    await removeBodies(
      this,
      dropped.map((entry) => entry.callId)
    )
  }

  /** The body first, so a row never names a body that is not there. */
  async putCall(call: LocalCall, envelope: WebhookEnvelope): Promise<void> {
    await this.write(this.bodyPath(call.callId), envelope)
    await this.commit((store) => {
      store.calls = [...store.calls.filter((entry) => entry.callId !== call.callId), call]
    })
  }

  async dropCall(callId: string): Promise<void> {
    await this.load()
    if (!this.call(callId)) {
      return
    }
    await this.commit((store) => {
      store.calls = store.calls.filter((entry) => entry.callId !== callId)
    })
    await removeBodies(this, [callId])
  }

  intents(): readonly LocalIntent[] {
    return this.stored?.intents ?? []
  }

  /** A hook minted for an automation whose save has not landed yet. */
  async saveIntent(intent: LocalIntent): Promise<void> {
    await this.commit((store) => {
      store.intents = [...store.intents.filter((entry) => entry.hookId !== intent.hookId), intent]
    })
  }

  async dropIntent(hookId: string): Promise<void> {
    await this.load()
    if (!this.intents().some((entry) => entry.hookId === hookId)) {
      return
    }
    await this.commit((store) => {
      store.intents = store.intents.filter((entry) => entry.hookId !== hookId)
    })
  }

  /** Drops what nothing needs again: unlisted hooks, and bodies no ledger row owns. */
  async prune(
    keepHook: (hook: LocalHook) => boolean,
    keepCalls: ReadonlySet<string>
  ): Promise<void> {
    await this.load()
    const gone = this.calls()
      .filter((entry) => !keepCalls.has(entry.callId))
      .map((entry) => entry.callId)
    if (gone.length === 0 && this.hooks().every(keepHook)) {
      return
    }
    await this.commit((store) => {
      store.hooks = store.hooks.filter(keepHook)
      const kept = new Set(store.hooks.map((hook) => hook.hookId))
      store.intents = store.intents.filter((intent) => kept.has(intent.hookId))
      store.calls = store.calls.filter((entry) => keepCalls.has(entry.callId))
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
