import { describe, expect, it } from 'vitest'
import { createFilesystemIndexRequestFences } from './filesystem-index-request-fences'

describe('filesystem index request fences', () => {
  it('resolves a live token only for the sender that began it', () => {
    const fences = createFilesystemIndexRequestFences()
    const senderSeven = fences.begin({
      senderId: 7,
      requestToken: 'token-a',
      consumerId: 'consumer-a',
      signal: undefined
    })
    fences.begin({
      senderId: 8,
      requestToken: 'token-a',
      consumerId: 'consumer-b',
      signal: undefined
    })

    expect(fences.liveRequest(7, 'token-a')).toBe(senderSeven)
    expect(fences.liveRequest(7, 'token-a')?.consumerId).toBe('consumer-a')
    expect(fences.liveRequest(8, 'token-a')?.consumerId).toBe('consumer-b')
    expect(fences.liveRequest(7, 'token-b')).toBeNull()
  })

  it('forgets a settled request so a later cancel owns no consumer', () => {
    const fences = createFilesystemIndexRequestFences()
    const fence = fences.begin({
      senderId: 7,
      requestToken: 'token-a',
      consumerId: 'consumer-a',
      signal: undefined
    })

    fences.forget(7, 'token-a', fence)

    expect(fences.liveRequest(7, 'token-a')).toBeNull()
  })

  it('keeps a newer request that reused a settled token', () => {
    const fences = createFilesystemIndexRequestFences()
    const settled = fences.begin({
      senderId: 7,
      requestToken: 'token-a',
      consumerId: 'consumer-a',
      signal: undefined
    })
    const reused = fences.begin({
      senderId: 7,
      requestToken: 'token-a',
      consumerId: 'consumer-b',
      signal: undefined
    })

    fences.forget(7, 'token-a', settled)

    expect(fences.liveRequest(7, 'token-a')).toBe(reused)
  })

  it('reads cancellation from the request lifetime it began with', () => {
    const fences = createFilesystemIndexRequestFences()
    const controller = new AbortController()
    const fence = fences.begin({
      senderId: 7,
      requestToken: 'token-a',
      consumerId: 'consumer-a',
      signal: controller.signal
    })

    expect(fence?.isCancelled()).toBe(false)
    controller.abort()
    expect(fence?.isCancelled()).toBe(true)
  })

  it('begins nothing without a request token', () => {
    const fences = createFilesystemIndexRequestFences()

    expect(
      fences.begin({ senderId: 7, requestToken: undefined, consumerId: null, signal: undefined })
    ).toBeNull()
    expect(fences.liveRequest(7, 'consumer-a')).toBeNull()
  })
})
