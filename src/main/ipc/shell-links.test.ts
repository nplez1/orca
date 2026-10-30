import { beforeEach, describe, expect, it, vi } from 'vitest'
import { markContextualLinkRouterReady } from '../window/contextual-link-relay'

const { handleMock, openExternalMock, onMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  openExternalMock: vi.fn(),
  onMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, on: onMock },
  shell: { openExternal: openExternalMock },
  dialog: { showOpenDialog: vi.fn() }
}))

import { registerShellHandlers } from './shell'

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>

const store = {
  getSettings: () => ({ activeRuntimeEnvironmentId: null }),
  getSshTarget: () => undefined
}

function handlerFor(channel: string): Handler {
  handleMock.mockReset()
  registerShellHandlers(store as never)
  const call = handleMock.mock.calls.find((entry: unknown[]) => entry[0] === channel)
  if (!call) {
    throw new Error(`${channel} handler not registered`)
  }
  const handler: Handler = call[1]
  return handler
}

function sender(options: { routesLinks: boolean }) {
  const contents = { id: 1, isDestroyed: () => false, send: vi.fn() }
  if (options.routesLinks) {
    markContextualLinkRouterReady(contents)
  }
  return contents
}

describe('shell link opening', () => {
  beforeEach(() => {
    handleMock.mockReset()
    openExternalMock.mockReset()
  })

  // The window owns the link-routing preference, so main must not pick the destination itself.
  it('relays shell:openUrl to a window that routes links', async () => {
    const window = sender({ routesLinks: true })

    await handlerFor('shell:openUrl')({ sender: window }, 'https://example.com/docs')

    expect(window.send).toHaveBeenCalledWith('link:openContextual', 'https://example.com/docs')
    expect(openExternalMock).not.toHaveBeenCalled()
  })

  it('falls back to the OS browser when the window routes nothing', async () => {
    const window = sender({ routesLinks: false })

    await handlerFor('shell:openUrl')({ sender: window }, 'https://example.com/docs')

    expect(openExternalMock).toHaveBeenCalledWith('https://example.com/docs')
    expect(window.send).not.toHaveBeenCalled()
  })

  // The router's own system branch calls this, so relaying here would loop forever.
  it('never relays the explicit system-browser open', async () => {
    const window = sender({ routesLinks: true })

    await handlerFor('shell:openUrlInSystemBrowser')({ sender: window }, 'https://example.com/docs')

    expect(openExternalMock).toHaveBeenCalledWith('https://example.com/docs')
    expect(window.send).not.toHaveBeenCalled()
  })

  it('normalizes an http URL before handing it over', async () => {
    const window = sender({ routesLinks: false })

    await handlerFor('shell:openUrl')({ sender: window }, 'HTTPS://Example.com')

    expect(openExternalMock).toHaveBeenCalledWith('https://example.com/')
  })

  it.each(['shell:openUrl', 'shell:openUrlInSystemBrowser'])(
    '%s refuses a non-web scheme',
    async (channel) => {
      const window = sender({ routesLinks: true })

      await handlerFor(channel)({ sender: window }, 'file:///etc/passwd')

      expect(openExternalMock).not.toHaveBeenCalled()
      expect(window.send).not.toHaveBeenCalled()
    }
  )

  it('registers the router-ready handshake as a listener', () => {
    handlerFor('shell:openUrl')

    expect(onMock).toHaveBeenCalledWith('link:routerReady', expect.any(Function))
  })
})
