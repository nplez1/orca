import { beforeEach, describe, expect, it, vi } from 'vitest'

const { connectMock } = vi.hoisted(() => ({ connectMock: vi.fn() }))

// Why: the balance readout dials the control-plane gateway over node:http2, so the
// connection is the one surface to fake — the protobuf framing stays real.
vi.mock('node:http2', () => ({ default: { connect: connectMock } }))

import { fetchFireworksBalance } from './fireworks-balance-client'

function fakeClient(): {
  client: {
    request: ReturnType<typeof vi.fn>
    on: ReturnType<typeof vi.fn>
    destroy: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
  }
} {
  const request = { on: vi.fn(), end: vi.fn() }
  return {
    client: {
      request: vi.fn(() => request),
      on: vi.fn(),
      destroy: vi.fn(),
      close: vi.fn()
    }
  }
}

describe('fetchFireworksBalance', () => {
  beforeEach(() => {
    connectMock.mockReset()
  })

  it('never dials the gateway when the cycle is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    const result = await fetchFireworksBalance({
      apiKey: 'fw-key',
      accountId: 'acct-1',
      signal: controller.signal
    })

    expect(result).toBeNull()
    expect(connectMock).not.toHaveBeenCalled()
  })

  it('destroys the connection when the cycle aborts mid-request', async () => {
    const { client } = fakeClient()
    connectMock.mockReturnValue(client)
    const controller = new AbortController()

    const pending = fetchFireworksBalance({
      apiKey: 'fw-key',
      accountId: 'acct-1',
      signal: controller.signal
    })
    controller.abort()

    await expect(pending).resolves.toBeNull()
    expect(client.destroy).toHaveBeenCalledTimes(1)
  })
})
