// What a sender posted, as Orca Cloud would have kept it: the body by its content type, and the headers
// minus our own token and any credential the sender added for us.
import type { IncomingMessage } from 'node:http'
import type { WebhookEnvelope } from '../../../shared/connector-webhook-routes'

const MAX_HEADER_VALUE_LENGTH = 1024
// A token is never part of the call as data, and neither is a credential the sender added for us.
const WITHHELD_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization'])

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
