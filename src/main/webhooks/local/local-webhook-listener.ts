// This computer's webhook endpoint: loopback only, an ephemeral port, and one route per hook whose
// token is the whole of the auth. A call is on disk before it is answered 200.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import {
  getEndpointFileName,
  isShellSafeEndpointValue
} from '../../../shared/agent-hook-listener/transport/endpoint-publication'
import { WEBHOOK_RUN_CAPS } from '../../../shared/connector-webhook-contract'
import type { WebhookEnvelope } from '../../../shared/connector-webhook-routes'
import { writeSecureFile } from '../../../shared/secure-storage/secure-file'
import { LOCAL_WEBHOOK_DIR, type LocalHook } from './local-webhook-store'

export const MAX_LOCAL_WEBHOOK_BODY_BYTES = 2 * 1024 * 1024
/** A rolling hour, which is the window the contract's per-hook run cap counts in. */
export const LOCAL_WEBHOOK_HOUR_MS = 60 * 60 * 1000
const MAX_HEADER_VALUE_LENGTH = 1024
const HOOK_PATH = /^\/hook\/(wh_[A-Za-z0-9]{16})\/([^/]+)$/
// A token is never part of the call as data, and neither is a credential the sender added for us.
const WITHHELD_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization'])

export type LocalWebhookCall = { hookId: string; callId: string; envelope: WebhookEnvelope }

export type LocalWebhookListenerDeps = {
  userDataPath: string
  hook: (hookId: string) => LocalHook | undefined
  /** The calls this hook has already taken since `since`, for its hourly cap. */
  taken: (hookId: string, since: number) => number
  /** Keeps the call durably; false when it could not be kept, and then nothing is acknowledged. */
  deliver: (call: LocalWebhookCall) => boolean
  /** Every hook's complete URL, for the discovery route the endpoint file's token opens. */
  urls: () => readonly { hookId: string; url: string }[]
  now?: () => number
}

export class LocalWebhookListener {
  private server: Server | null = null
  private bound: number | null = null
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

  /** The hook's URL without its token, as every webhook view names one. */
  url(hookId: string): string | null {
    return this.bound === null ? null : `http://127.0.0.1:${this.bound}/hook/${hookId}`
  }

  async start(): Promise<void> {
    if (this.server) {
      return
    }
    const server = createServer((request, response) => void this.handle(request, response))
    server.headersTimeout = 10_000
    server.requestTimeout = 30_000
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error): void => {
        server.off('listening', bound)
        reject(error)
      }
      const bound = (): void => {
        server.off('error', failed)
        resolve()
      }
      server.once('error', failed)
      server.once('listening', bound)
      server.listen(0, '127.0.0.1')
    })
    const address = server.address()
    if (address === null || typeof address === 'string') {
      server.close()
      throw new Error('local webhooks could not bind a port')
    }
    this.server = server
    this.bound = address.port
    this.publishEndpoint()
    server.on('error', (error) => {
      console.warn('[webhooks] this computer’s local webhook listener failed', error)
    })
  }

  stop(): void {
    this.server?.closeAllConnections()
    this.server?.close()
    this.server = null
    this.bound = null
    try {
      rmSync(this.endpointPath, { force: true })
    } catch (error) {
      console.warn('[webhooks] could not remove the local webhook endpoint file', error)
    }
  }

  private get endpointPath(): string {
    return join(this.deps.userDataPath, LOCAL_WEBHOOK_DIR, getEndpointFileName())
  }

  /** The port and the per-computer token, in the shape the agent-hook listener publishes its own. */
  private publishEndpoint(): void {
    if (this.bound === null) {
      return
    }
    const prefix = process.platform === 'win32' ? 'set ' : ''
    const separator = process.platform === 'win32' ? '\r\n' : '\n'
    const values: [string, string][] = [
      ['ORCA_LOCAL_WEBHOOK_PORT', String(this.bound)],
      ['ORCA_LOCAL_WEBHOOK_TOKEN', this.adminToken],
      ['ORCA_LOCAL_WEBHOOK_URL', `http://127.0.0.1:${this.bound}`]
    ]
    for (const [key, value] of values) {
      if (!isShellSafeEndpointValue(value)) {
        throw new Error(`${key} is not safe to write to a shell-sourced file`)
      }
    }
    const lines = [...values.map(([key, value]) => `${prefix}${key}=${value}`), '']
    const written = writeSecureFile(this.endpointPath, lines.join(separator), { ownerOnly: true })
    if (!written) {
      throw new Error('the local webhook endpoint file could not be made owner-only')
    }
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
      if (
        this.deps.taken(hookId, this.now() - LOCAL_WEBHOOK_HOUR_MS) >= WEBHOOK_RUN_CAPS.hookDefault
      ) {
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
      if (!this.deps.deliver(call)) {
        answer(response, 500)
        return
      }
      answer(response, 200, { ok: true, callId })
    } catch (error) {
      console.warn('[webhooks] a local delivery failed', error)
      answer(response, 400)
    }
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
    answer(response, 200, { ok: true, port: this.bound, hooks: this.deps.urls() })
  }
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

/** What the sender posted, as the cloud would have kept it: the body by its type, headers minus ours. */
export function localWebhookEnvelope(
  request: IncomingMessage,
  bytes: Buffer,
  receivedAt: number,
  token: string
): WebhookEnvelope {
  const contentType = headerOf(request, 'content-type')?.slice(0, MAX_HEADER_VALUE_LENGTH) ?? null
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(request.headers)) {
    if (WITHHELD_HEADERS.has(name)) {
      continue
    }
    const text = Array.isArray(value) ? value.join(', ') : value
    if (text === undefined || text.includes(token)) {
      continue
    }
    headers[name] = text.slice(0, MAX_HEADER_VALUE_LENGTH)
  }
  return {
    receivedAt,
    contentType,
    headers,
    body: localWebhookBody(contentType, bytes),
    truncated: false
  }
}

function headerOf(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  return Array.isArray(value) ? value.join(', ') : value
}

function localWebhookBody(contentType: string | null, bytes: Buffer): WebhookEnvelope['body'] {
  const text = bytes.toString('utf8')
  const type = contentType?.toLowerCase() ?? ''
  if (type.includes('json')) {
    try {
      const value: unknown = JSON.parse(text)
      return { kind: 'json', value }
    } catch {
      return { kind: 'text', value: text }
    }
  }
  if (type.includes('x-www-form-urlencoded')) {
    const value: Record<string, string | string[]> = {}
    for (const [key, entry] of new URLSearchParams(text)) {
      const known = value[key]
      value[key] =
        known === undefined ? entry : Array.isArray(known) ? [...known, entry] : [known, entry]
    }
    return { kind: 'form', value }
  }
  return { kind: 'text', value: text }
}
