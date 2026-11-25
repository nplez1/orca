import { Readable } from 'node:stream'
import { net, type ClientRequest, type Session } from 'electron'
import { getElectronProxyCredentialsForChallenge } from '../network/electron-proxy-credentials'

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304])

function webBody(response: Readable, request: ClientRequest): ReadableStream<Uint8Array> {
  const chunks: AsyncIterator<Uint8Array> = response[Symbol.asyncIterator]()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await chunks.next()
      if (done) {
        controller.close()
      } else {
        controller.enqueue(value)
      }
    },
    // iterator.return() would queue behind a pending read on a stalled body.
    cancel: () => {
      response.destroy()
      request.abort()
    }
  })
}

/** fork-comment-ok: `login` answers proxy challenges only. Electron cancels one nobody answers, so
 * a bare `net.request` behind an authenticated proxy would 407 every call (see `fetchWithProxyLogin`).
 */
export function fetchWithElectronManualRedirects(
  url: string,
  init: RequestInit = {},
  session?: Session
): Promise<Response> {
  const { signal } = init
  if (signal?.aborted) {
    return Promise.reject(signal.reason)
  }
  return new Promise((resolve, reject) => {
    const origin = new Headers(init.headers).get('origin') ?? undefined
    const request = net.request({
      url,
      method: 'GET',
      redirect: 'manual',
      // fork-comment-ok: Jenkins authenticates some routes by session cookie alone, and credential
      // headers stay the caller's to replay hop by hop — the point of this follower.
      credentials: init.credentials === 'omit' ? 'omit' : origin ? 'same-origin' : 'include',
      ...(session ? { session } : {})
    })
    let challenged = false
    request.on('login', (authInfo, callback) => {
      const credentials =
        challenged || !session ? null : getElectronProxyCredentialsForChallenge(session, authInfo)
      challenged = true
      if (credentials) {
        callback(credentials.username, credentials.password)
      } else {
        callback()
      }
    })
    // fork-comment-ok: a caller vetting its own hops still authenticates the one it approved.
    for (const [key, value] of new Headers(init.headers)) {
      request.setHeader(key, value)
    }
    const fail = (error: unknown): void => {
      request.abort()
      reject(error)
    }
    signal?.addEventListener('abort', () => fail(signal.reason), { once: true })
    request.on('redirect', (statusCode, _method, redirectUrl, responseHeaders) => {
      try {
        const headers = new Headers({ location: redirectUrl })
        for (const [key, values] of Object.entries(responseHeaders)) {
          headers.set(key, values.join(', '))
        }
        resolve(new Response(null, { headers, status: statusCode }))
        request.abort()
      } catch (error) {
        fail(error)
      }
    })
    request.on('response', (response) => {
      if (!(response instanceof Readable)) {
        fail(new TypeError('Electron response is not a readable stream'))
        return
      }
      try {
        const headers = new Headers()
        for (const [key, value] of Object.entries(response.headers)) {
          headers.set(key, Array.isArray(value) ? value.join(', ') : value)
        }
        const body = NULL_BODY_STATUSES.has(response.statusCode) ? null : webBody(response, request)
        // Caller deadlines and late errors must also end stalled bodies.
        signal?.addEventListener('abort', () => response.destroy(signal.reason), { once: true })
        request.on('error', (error) => response.destroy(error))
        resolve(new Response(body, { headers, status: response.statusCode }))
        if (!body) {
          response.destroy()
          request.abort()
        }
      } catch (error) {
        response.destroy()
        fail(error)
      }
    })
    request.on('error', reject)
    request.end()
  })
}
