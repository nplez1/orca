import type { Session } from 'electron'

/** Desktop uses Chromium session/proxy state and user agent; headless hosts use Node/environment defaults.
 * Callers must consume or cancel response bodies: unread undici bodies can crash the process. */

export type MainHttpClient = {
  fetch(url: string, init?: RequestInit): Promise<Response>
  /**
   * One hop, with a 3xx handed back instead of followed, so a caller can vet the destination before
   * the next request carries its credentials there. Absent only on a host whose transport cannot do
   * it, where a caller that must vet hops has to refuse instead.
   */
  fetchManualRedirects?(url: string, init?: RequestInit): Promise<Response>
  proxySession(): Session | null
  partitionSession?(partition: string): Session
}

const nodeHttpClient: MainHttpClient = {
  fetch: (url, init) => globalThis.fetch(url, init),
  fetchManualRedirects: (url, init) => globalThis.fetch(url, { ...init, redirect: 'manual' }),
  proxySession: () => null
}

let current: MainHttpClient = nodeHttpClient

export function setMainHttpClient(client: MainHttpClient | null): void {
  current = client ?? nodeHttpClient
}

export function getMainHttpClient(): MainHttpClient {
  return current
}

export function requirePartitionSession(partition: string, providerLabel: string): Session {
  const client = getMainHttpClient()
  if (!client.partitionSession) {
    throw new Error(
      `${providerLabel} usage from a session cookie needs the Orca desktop app and is not available on this server`
    )
  }
  return client.partitionSession(partition)
}
