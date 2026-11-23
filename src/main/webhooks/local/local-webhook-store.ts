// This computer's webhooks, in a file of the fork's own: Orca Cloud's ledger holds the cloud's hooks
// and the changes it has yet to confirm, and a local hook has neither, so it lives beside it rather
// than inside a schema the cloud owns.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import {
  WEBHOOK_CALL_ID_PATTERN,
  WEBHOOK_HOOK_ID_PATTERN
} from '../../../shared/connector-webhook-contract'
import { WebhookEnvelope } from '../../../shared/connector-webhook-routes'
import { writeDurableSecureJsonFile } from '../../../shared/secure-storage/secure-file'
import { isMissingFileError } from '../../runtime/rpc/server/pairing/device-registry-corruption'

export const LOCAL_WEBHOOK_DIR = 'local-webhooks'
const STORE_FILE = 'local-webhooks.json'
/** Local hooks have no revocation generation: one token, until the rule goes. */
export const LOCAL_WEBHOOK_EPOCH = 1

const HookId = z.string().regex(WEBHOOK_HOOK_ID_PATTERN)

const LocalHook = z.object({
  hookId: HookId,
  token: z.string().min(16),
  automationId: z.string().min(1),
  botId: z.string().min(1),
  epoch: z.literal(LOCAL_WEBHOOK_EPOCH),
  created: z.number()
})
export type LocalHook = z.infer<typeof LocalHook>

/** A call as the sender's bytes made it, kept until its run is done and the ledger's row is pruned. */
const LocalCall = z.object({
  callId: z.string().regex(WEBHOOK_CALL_ID_PATTERN),
  hookId: HookId,
  envelope: WebhookEnvelope
})
export type LocalCall = z.infer<typeof LocalCall>

const StoredStore = z.object({ hooks: z.array(LocalHook), calls: z.array(LocalCall) })
type StoredStore = z.infer<typeof StoredStore>

const emptyStore = (): StoredStore => ({ hooks: [], calls: [] })

export class LocalWebhookStore {
  private stored: StoredStore | null = null

  constructor(private readonly userDataPath: string) {}

  get path(): string {
    return join(this.userDataPath, LOCAL_WEBHOOK_DIR, STORE_FILE)
  }

  private read(): StoredStore {
    if (this.stored) {
      return this.stored
    }
    try {
      const parsed = StoredStore.safeParse(JSON.parse(readFileSync(this.path, 'utf8')))
      if (parsed.success) {
        this.stored = parsed.data
        return parsed.data
      }
    } catch (error) {
      if (!isMissingFileError(error)) {
        console.warn('[webhooks] this computer’s local webhooks were unreadable; starting empty')
      }
    }
    this.stored = emptyStore()
    return this.stored
  }

  /**
   * On disk before it is in memory: a hook or a call exists only once it survives a crash, which is
   * what lets the listener answer 200 for a call it has already kept.
   */
  private commit(change: (store: StoredStore) => void): void {
    const next = structuredClone(this.read())
    change(next)
    writeDurableSecureJsonFile(this.path, next)
    this.stored = next
  }

  hooks(): readonly LocalHook[] {
    return this.read().hooks
  }

  hook(hookId: string): LocalHook | undefined {
    return this.hooks().find((entry) => entry.hookId === hookId)
  }

  calls(): readonly LocalCall[] {
    return this.read().calls
  }

  call(callId: string): LocalCall | undefined {
    return this.calls().find((entry) => entry.callId === callId)
  }

  putHook(hook: LocalHook): void {
    this.commit((store) => {
      store.hooks = [...store.hooks.filter((entry) => entry.hookId !== hook.hookId), hook]
    })
  }

  /** A hook and the calls still waiting for it: nothing can answer for either once it is gone. */
  dropHook(hookId: string): void {
    this.commit((store) => {
      store.hooks = store.hooks.filter((entry) => entry.hookId !== hookId)
      store.calls = store.calls.filter((entry) => entry.hookId !== hookId)
    })
  }

  putCall(call: LocalCall): void {
    this.commit((store) => {
      store.calls = [...store.calls.filter((entry) => entry.callId !== call.callId), call]
    })
  }

  dropCall(callId: string): void {
    this.commit((store) => {
      store.calls = store.calls.filter((entry) => entry.callId !== callId)
    })
  }

  /** Drops what nothing needs again: hooks no automation lists, and bodies no ledger row owns. */
  prune(keepHook: (hook: LocalHook) => boolean, keepCalls: ReadonlySet<string>): void {
    const { hooks, calls } = this.read()
    const unchanged = hooks.every(keepHook) && calls.every((entry) => keepCalls.has(entry.callId))
    if (unchanged) {
      return
    }
    this.commit((store) => {
      store.hooks = store.hooks.filter(keepHook)
      store.calls = store.calls.filter((entry) => keepCalls.has(entry.callId))
    })
  }
}
