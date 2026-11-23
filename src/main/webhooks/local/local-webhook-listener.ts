// This computer's webhook endpoint: loopback only, one route per hook whose token is the whole of the
// auth, and a port derived from the profile so a forwarder's URL survives a restart. A call is on disk
// before it is answered 200.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import {
  getEndpointFileName,
  isShellSafeEndpointValue
} from '../../../shared/agent-hook-listener/transport/endpoint-publication'
import { WEBHOOK_RUN_CAPS } from '../../../shared/connector-webhook-contract'
import type { WebhookEnvelope } from '../../../shared/connector-webhook-routes'
import { writeSecureFileAsync } from '../../../shared/secure-storage/secure-file-async-write'
import { localWebhookEnvelope } from './local-webhook-envelope'
import { LOCAL_WEBHOOK_DIR, type LocalHook } from './local-webhook-store'

export const MAX_LOCAL_WEBHOOK_BODY_BYTES = 2 * 1024 * 1024
/** A rolling hour, which is the window the contract's per-hook run cap counts in. */
export const LOCAL_WEBHOOK_HOUR_MS = 60 * 60 * 1000
const PORT_BASE = 43000
const PORT_SPAN = 5000
const HOOK_PATH = /^\/hook\/(wh_[A-Za-z0-9]{16})\/([^/]+)$/

/**
 * The port this profile listens on, so `gh webhook forward --url=…` keeps working across restarts. The
 * instance lock means one runtime serves a profile, so the same profile cannot collide with itself; a
 * different one would have to hash into the same slot, and the fallback covers that.
 */
export function localWebhookPort(userDataPath: string): number {
  const digest = createHash('sha256').update(userDataPath).digest()
  return PORT_BASE + (digest.readUInt16BE(0) % PORT_SPAN)
}

export type LocalWebhookCall = { hookId: string; callId: string; envelope: WebhookEnvelope }

/** What the listener did with a delivery it authenticated. */
export type LocalWebhookVerdict = 'kept' | 'over_cap' | 'failed'

export type LocalWebhookListenerDeps = {
  userDataPath: string
  hook: (hookId: string) => LocalHook | undefined
  /** The calls this hook has already taken since `since`, for its hourly cap. */
  taken: (hookId: string, since: number) => number
  /** Keeps the call durably, and re-checks the cap as it does, so concurrent senders cannot pass it. */
  deliver: (call: LocalWebhookCall) => Promise<LocalWebhookVerdict>
  /** Every hook's complete URL, for the discovery route the endpoint file's token opens. */
  urls: () => readonly { hookId: string; url: string }[]
  now?: () => number
}

export class LocalWebhookListener {
  private server: Server | null = null
  private starting: Promise<void> | null = null
  private bound: number | null = null
  private derived = false
  private readonly adminToken = randomBytes(32).toString('base64url')
  private readonly now: () => number

  constructor(private readonly deps: LocalWebhookListenerDeps) {
    this.now = deps.now ?? Date.now
  }

  listening(): boolean {
    return this.bound !== null
  }

  /** The port it bound, for the tests and for a caller that would rather read it than the endpoint file. */
  port(): number | null {
    return this.bound
  }

  /** Whether it holds the port this profile names, rather than the ephemeral one it fell back to. */
  stable(): boolean {
    return this.bound !== null && this.derived
  }

  /** The hook's URL without its token, as every webhook view names one; null while nothing serves it. */
  url(hookId: string): string | null {
    return this.bound === null ? null : `http://127.0.0.1:${this.bound}/hook/${hookId}`
  }

  start(): Promise<void> {
    if (this.server) {
      return Promise.resolve()
    }
    this.starting ??= this.listen().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async listen(): Promise<void> {
    const server = createServer((request, response) => void this.handle(request, response))
    server.headersTimeout = 10_000
    server.requestTimeout = 30_000
    const wanted = localWebhookPort(this.deps.userDataPath)
    try {
      this.bound = await bind(server, wanted)
      this.derived = true
    } catch (error) {
      // Another process holds this profile's port: take an ephemeral one rather than not listening.
      console.warn(
        `[webhooks] port ${wanted} is taken, so this computer's webhook URL changes on restart`,
        error
      )
      this.bound = await bind(server, 0)
      this.derived = false
    }
    this.server = server
    server.on('error', (error) => {
      console.warn('[webhooks] this computer’s local webhook listener failed', error)
    })
    try {
      await this.publishEndpoint()
    } catch (error) {
      // A delivery still has to be served: the endpoint file is discovery, not the route itself.
      console.warn('[webhooks] could not publish where this computer listens', error)
    }
  }

  stop(): void {
    this.starting = null
    this.server?.closeAllConnections()
    this.server?.close()
    this.server = null
    this.bound = null
    this.derived = false
    void rm(this.endpointPath, { force: true }).catch((error: unknown) => {
      console.warn('[webhooks] could not remove the local webhook endpoint file', error)
    })
  }

  private get endpointPath(): string {
    return join(this.deps.userDataPath, LOCAL_WEBHOOK_DIR, getEndpointFileName())
  }

  /** The port and the per-computer token, in the shape the agent-hook listener publishes its own. */
  private async publishEndpoint(): Promise<void> {
    if (this.bound === null) {
      return
    }
    const prefix = process.platform === 'win32' ? 'set ' : ''
    const separator = process.platform === 'win32' ? '\r\n' : '\n'
    const values: [string, string][] = [
      ['ORCA_LOCAL_WEBHOOK_PORT', String(this.bound)],
      ['ORCA_LOCAL_WEBHOOK_TOKEN', this.adminToken],
      ['ORCA_LOCAL_WEBHOOK_URL', `http://127.0.0.1:${this.bound}`],
      // 0 means the URL changes on the next restart; see the note on localWebhookPort.
      ['ORCA_LOCAL_WEBHOOK_STABLE', this.derived ? '1' : '0']
    ]
    for (const [key, value] of values) {
      if (!isShellSafeEndpointValue(value)) {
        throw new Error(`${key} is not safe to write to a shell-sourced file`)
      }
    }
    const lines = [...values.map(([key, value]) => `${prefix}${key}=${value}`), '']
    await writeSecureFileAsync(this.endpointPath, lines.join(separator))
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const { pathname } = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (pathname === '/state') {
        this.answerState(request, response)
        return
      }
      const match = HOOK_PATH.exec(pathname)
      if (!match) {
        answer(response, 404)
        return
      }
      if (request.method !== 'POST') {
        answer(response, 405)
        return
      }
      const [, hookId, token] = match
      const hook = this.deps.hook(hookId)
      if (!hook) {
        answer(response, 404)
        return
      }
      if (!sameToken(token, hook.token)) {
        answer(response, 401)
        return
      }
      // Asked before the body is read, so a sender past its cap costs us no memory to refuse.
      if (this.overCap(hookId)) {
        answer(response, 429)
        return
      }
      const bytes = await readCappedBody(request)
      if (bytes === null) {
        answer(response, 413)
        return
      }
      const callId = newCallId()
      const call: LocalWebhookCall = {
        hookId,
        callId,
        envelope: localWebhookEnvelope(request, bytes, this.now(), hook.token)
      }
      // Asked again as the call is kept: reading the body is awaited, so senders that arrived together
      // all passed the check above, and only the count at admission can hold the cap.
      const verdict = await this.deps.deliver(call)
      if (verdict === 'over_cap') {
        answer(response, 429)
        return
      }
      if (verdict !== 'kept') {
        answer(response, 500)
        return
      }
      answer(response, 200, { ok: true, callId })
    } catch (error) {
      console.warn('[webhooks] a local delivery failed', error)
      answer(response, 400)
    }
  }

  private overCap(hookId: string): boolean {
    return (
      this.deps.taken(hookId, this.now() - LOCAL_WEBHOOK_HOUR_MS) >= WEBHOOK_RUN_CAPS.hookDefault
    )
  }

  private answerState(request: IncomingMessage, response: ServerResponse): void {
    if (request.method !== 'GET') {
      answer(response, 405)
      return
    }
    const given = bearer(request.headers.authorization)
    if (given === null || !sameToken(given, this.adminToken)) {
      answer(response, 401)
      return
    }
    answer(response, 200, {
      ok: true,
      port: this.bound,
      stable: this.derived,
      hooks: this.deps.urls()
    })
  }
}

/** Binds the port, or rejects with the reason it could not; the port 0 case takes any free one. */
function bind(server: Server, port: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const failed = (error: Error): void => {
      server.off('listening', bound)
      reject(error)
    }
    const bound = (): void => {
      server.off('error', failed)
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('local webhooks could not bind a port'))
        return
      }
      resolve(address.port)
    }
    server.once('error', failed)
    server.once('listening', bound)
    server.listen(port, '127.0.0.1')
  })
}

function answer(response: ServerResponse, status: number, body?: unknown): void {
  if (response.headersSent) {
    return
  }
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(body === undefined ? '' : JSON.stringify(body))
}

/** Compared as digests, so the time taken says nothing about how much of the token was right. */
function sameToken(given: string, expected: string): boolean {
  return timingSafeEqual(digest(given), digest(expected))
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

function bearer(value: string | undefined): string | null {
  const match = value === undefined ? null : /^Bearer (\S+)$/i.exec(value)
  return match?.[1] ?? null
}

/** The body as bytes, or null once it is over the cap; the rest is drained so the answer still lands. */
function readCappedBody(request: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_LOCAL_WEBHOOK_BODY_BYTES) {
        request.removeAllListeners('data')
        request.resume()
        resolve(null)
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

function newCallId(): string {
  return `call_${randomBytes(10).toString('hex')}`
}
