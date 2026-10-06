import { describe, expect, it } from 'vitest'
import { createFilesystemIndexConsumerTokens } from './filesystem-index-consumer-tokens'

describe('filesystem index consumer tokens', () => {
  it('resolves a token only for the sender that submitted it', () => {
    const tokens = createFilesystemIndexConsumerTokens()
    tokens.record(7, 'token-a', 'consumer-a')
    tokens.record(8, 'token-a', 'consumer-b')

    expect(tokens.lookup(7, 'token-a')).toBe('consumer-a')
    expect(tokens.lookup(8, 'token-a')).toBe('consumer-b')
    expect(tokens.lookup(7, 'token-b')).toBeNull()
  })

  it('forgets a settled request so a later cancel cannot reach its consumer', () => {
    const tokens = createFilesystemIndexConsumerTokens()
    tokens.record(7, 'token-a', 'consumer-a')

    tokens.forget(7, 'token-a')

    expect(tokens.lookup(7, 'token-a')).toBeNull()
  })

  it('ignores recording without a request token', () => {
    const tokens = createFilesystemIndexConsumerTokens()
    tokens.record(7, undefined, 'consumer-a')

    expect(tokens.lookup(7, 'consumer-a')).toBeNull()
  })
})
