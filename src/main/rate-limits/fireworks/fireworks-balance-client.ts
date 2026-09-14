import http2 from 'node:http2'
import type { MoneyAmount } from '../../../shared/money-amount'
import { decodeFireworksBalance, encodeGetBalanceRequest } from './fireworks-balance-protobuf'

/**
 * Reads the account credit balance from Fireworks' control plane.
 *
 * Why this exists at all: Fireworks publishes no REST route for credit balance —
 * their prepaid credits appear only in the web dashboard. `GET /v1/accounts/{id}/
 * usageLimits` is not it either; it answers `code 9, "usage limits are not enabled
 * for account …"` on self-serve accounts, so there is no documented alternative.
 *
 * Provenance: the gateway path, the `x-api-key` metadata auth and the message
 * shapes were recovered from the unstripped `firectl` binary, which is a thin
 * client over `gateway.Gateway` (the control-plane host, distinct from the
 * `api.fireworks.ai` inference host). No `firectl` subcommand reaches `GetBalance`,
 * so this calls the method directly.
 *
 * Caveats worth knowing before touching this:
 *   - It is an internal API with no compatibility contract; it can change or
 *     disappear without notice. Callers must treat a null result as normal.
 *   - `http2.connect` dials the host directly, so it deliberately does NOT go
 *     through Electron's proxied default session the way `net.fetch` callers do.
 *     A proxied environment degrades to the spend-only readout rather than failing.
 */
const GATEWAY_ORIGIN = 'https://gateway.fireworks.ai:443'
const GRPC_SERVICE = 'gateway.Gateway'
const BALANCE_TIMEOUT_MS = 10_000
const GRPC_STATUS_OK = '0'

type GrpcResponse = {
  grpcStatus: string | undefined
  grpcMessage: string | undefined
  message: Buffer | null
}

/** Node types header values as `string | string[]`; gRPC sends single values. */
function readHeaderText(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function callGateway(method: string, apiKey: string, body: Buffer): Promise<GrpcResponse> {
  return new Promise((resolve, reject) => {
    const client = http2.connect(GATEWAY_ORIGIN)
    const chunks: Buffer[] = []
    let headers: http2.IncomingHttpHeaders = {}
    let trailers: http2.IncomingHttpHeaders = {}
    let settled = false

    const finish = (run: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      run()
    }

    const timer = setTimeout(() => {
      finish(() => {
        client.destroy()
        reject(new Error(`Fireworks ${method} timed out after ${BALANCE_TIMEOUT_MS}ms`))
      })
    }, BALANCE_TIMEOUT_MS)

    client.on('error', (error) => {
      finish(() => reject(error))
    })

    const request = client.request({
      ':method': 'POST',
      ':path': `/${GRPC_SERVICE}/${method}`,
      'content-type': 'application/grpc',
      te: 'trailers',
      'x-api-key': apiKey,
      'grpc-timeout': `${BALANCE_TIMEOUT_MS / 1000}S`
    })

    request.on('response', (responseHeaders) => {
      headers = responseHeaders
    })
    request.on('trailers', (responseTrailers) => {
      trailers = responseTrailers
    })
    request.on('error', (error: Error) => {
      finish(() => reject(error))
    })
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })
    request.on('end', () => {
      finish(() => {
        client.close()
        resolve({
          // A trailers-only response carries the status in the headers instead.
          grpcStatus: readHeaderText(trailers['grpc-status'] ?? headers['grpc-status']),
          grpcMessage: readHeaderText(trailers['grpc-message'] ?? headers['grpc-message']),
          message: unframeGrpcMessage(Buffer.concat(chunks))
        })
      })
    })

    // gRPC frame: 1 compression-flag byte + 4-byte big-endian message length.
    const frame = Buffer.alloc(5)
    frame.writeUInt32BE(body.length, 1)
    request.end(Buffer.concat([frame, body]))
  })
}

function unframeGrpcMessage(payload: Buffer): Buffer | null {
  if (payload.length <= 5) {
    return null
  }
  const declaredLength = payload.readUInt32BE(1)
  const end = Math.min(5 + declaredLength, payload.length)
  return payload.subarray(5, end)
}

/**
 * Null on any failure — a missing credential, an unreachable gateway, a proxy that
 * cannot reach it, a revoked key, or a schema change. The caller keeps its
 * spend-based readout, so this readout degrading never blanks the provider.
 */
export async function fetchFireworksBalance(args: {
  apiKey: string
  accountId: string
}): Promise<MoneyAmount | null> {
  try {
    const response = await callGateway(
      'GetBalance',
      args.apiKey,
      encodeGetBalanceRequest(`accounts/${args.accountId}`)
    )
    if (response.grpcStatus !== GRPC_STATUS_OK) {
      console.warn(
        `[fireworks] GetBalance returned grpc-status=${response.grpcStatus ?? 'none'} ${response.grpcMessage ?? ''}`.trim()
      )
      return null
    }
    if (!response.message) {
      return null
    }
    return decodeFireworksBalance(response.message)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn('[fireworks] GetBalance unavailable; falling back to spend only:', message)
    return null
  }
}
