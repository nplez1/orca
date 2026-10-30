// @vitest-environment happy-dom
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const storeState: { activeWorktreeId: string | null } = { activeWorktreeId: 'wt-1' }
  const relay: { callback: ((url: string) => void) | null } = { callback: null }
  const calls: string[] = []
  return {
    openContextualHttpLink: vi.fn(),
    storeState,
    calls,
    relay,
    unsubscribe: vi.fn()
  }
})

vi.mock('@/store', () => ({
  useAppStore: { getState: () => mocks.storeState }
}))

vi.mock('@/lib/contextual-http-link', () => ({
  openContextualHttpLink: mocks.openContextualHttpLink
}))

import { useContextualLinkRouter } from './use-contextual-link-router'

function Harness(): null {
  useContextualLinkRouter()
  return null
}

describe('useContextualLinkRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.storeState.activeWorktreeId = 'wt-1'
    mocks.calls.length = 0
    mocks.relay.callback = null
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        shell: {
          onContextualLinkRequested: (callback: (url: string) => void) => {
            mocks.calls.push('subscribe')
            mocks.relay.callback = callback
            return mocks.unsubscribe
          },
          markContextualLinkRouterReady: () => {
            mocks.calls.push('announce')
          }
        }
      }
    })
  })

  afterEach(() => {
    cleanup()
    Reflect.deleteProperty(window, 'api')
  })

  // Main only relays once the announcement lands, so the listener must already be attached.
  it('subscribes before announcing readiness', () => {
    render(<Harness />)

    expect(mocks.calls).toEqual(['subscribe', 'announce'])
  })

  it('opens a relayed link in the active workspace', () => {
    render(<Harness />)

    mocks.relay.callback?.('https://example.com/docs')

    expect(mocks.openContextualHttpLink).toHaveBeenCalledWith('https://example.com/docs', {
      worktreeId: 'wt-1'
    })
  })

  it('reads the workspace at open time, not at subscribe time', () => {
    render(<Harness />)
    mocks.storeState.activeWorktreeId = 'wt-2'

    mocks.relay.callback?.('https://example.com/docs')

    expect(mocks.openContextualHttpLink).toHaveBeenCalledWith('https://example.com/docs', {
      worktreeId: 'wt-2'
    })
  })

  it('unsubscribes on unmount', async () => {
    const view = render(<Harness />)

    view.unmount()

    await waitFor(() => expect(mocks.unsubscribe).toHaveBeenCalled())
  })
})
