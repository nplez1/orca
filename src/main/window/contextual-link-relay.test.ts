import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  contextualLinkOpenChannel,
  contextualLinkRouterReadyChannel
} from '../../shared/contextual-link-channels'

const ipcMainHandlers = new Map<string, (event: { sender: unknown }) => void>()

vi.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, handler: (event: { sender: unknown }) => void) => {
      ipcMainHandlers.set(channel, handler)
    }
  }
}))

import {
  isContextualLinkRouterReady,
  markContextualLinkRouterReady,
  registerContextualLinkRouterHandshake,
  relayContextualLink
} from './contextual-link-relay'

function createContents(overrides: { destroyed?: boolean } = {}) {
  return {
    id: 1,
    isDestroyed: () => overrides.destroyed === true,
    send: vi.fn()
  }
}

describe('contextual link relay', () => {
  beforeEach(() => {
    ipcMainHandlers.clear()
  })

  it('refuses to relay to a window that has not announced its router', () => {
    const contents = createContents()

    expect(relayContextualLink(contents, 'https://example.com/')).toBe(false)
    expect(contents.send).not.toHaveBeenCalled()
  })

  it('relays to a window that announced its router', () => {
    const contents = createContents()
    markContextualLinkRouterReady(contents)

    expect(isContextualLinkRouterReady(contents)).toBe(true)
    expect(relayContextualLink(contents, 'https://example.com/')).toBe(true)
    expect(contents.send).toHaveBeenCalledWith(contextualLinkOpenChannel, 'https://example.com/')
  })

  it('marks only the announcing window as ready', () => {
    const ready = createContents()
    const other = createContents()

    registerContextualLinkRouterHandshake()
    ipcMainHandlers.get(contextualLinkRouterReadyChannel)?.({ sender: ready })

    expect(isContextualLinkRouterReady(ready)).toBe(true)
    expect(isContextualLinkRouterReady(other)).toBe(false)
    expect(relayContextualLink(other, 'https://example.com/')).toBe(false)
  })

  // A crashed or closing renderer must not swallow the click it was about to receive.
  it('refuses a ready window that has since been destroyed', () => {
    const contents = createContents({ destroyed: true })
    markContextualLinkRouterReady(contents)

    expect(relayContextualLink(contents, 'https://example.com/')).toBe(false)
    expect(contents.send).not.toHaveBeenCalled()
  })
})
