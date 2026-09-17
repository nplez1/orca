// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AI_VAULT_HOST_QUERY_DEBOUNCE_MS, useAiVaultHostQuery } from './ai-vault-host-query'

// The hook is the pause between a keystroke and a host request, so every case
// here is about what the host would see and when.

function renderHostQuery(query = ''): ReturnType<typeof renderHook<string, { query: string }>> {
  return renderHook(({ query }: { query: string }) => useAiVaultHostQuery(query), {
    initialProps: { query }
  })
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

describe('useAiVaultHostQuery', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not leave for the host before the debounce elapses', () => {
    const { result, rerender } = renderHostQuery()
    rerender({ query: 'vault' })

    advance(AI_VAULT_HOST_QUERY_DEBOUNCE_MS - 1)
    expect(result.current).toBe('')

    advance(1)
    expect(result.current).toBe('vault')
  })

  it('clears immediately instead of waiting out the debounce', () => {
    const { result, rerender } = renderHostQuery('vault')
    expect(result.current).toBe('vault')

    // No timer advance: clearing has to bring the whole list back at once.
    rerender({ query: '' })
    expect(result.current).toBe('')
  })

  it('settles once for two keystrokes inside the window', () => {
    const { result, rerender } = renderHostQuery()
    rerender({ query: 'va' })
    advance(100)
    rerender({ query: 'vault' })

    // Past the first timer's due time but short of the second's. It landing as
    // `va` here is what a missing timer clear would look like.
    advance(200)
    expect(result.current).toBe('')

    advance(50)
    expect(result.current).toBe('vault')
  })

  it('never sends an operator query, and drops a host filter it supersedes', () => {
    const { result, rerender } = renderHostQuery('vault')
    expect(result.current).toBe('vault')

    // A host cannot key `repo:`/`path:`, so the previous filter must not stay
    // applied while the client answers the operator itself.
    rerender({ query: 'vault path:/repo' })
    expect(result.current).toBe('')

    rerender({ query: 'path:/repo' })
    advance(AI_VAULT_HOST_QUERY_DEBOUNCE_MS)
    expect(result.current).toBe('')
  })
})
