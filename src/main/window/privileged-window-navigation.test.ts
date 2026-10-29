import { beforeEach, describe, expect, it, vi } from 'vitest'

const openExternal = vi.fn()
vi.mock('electron', () => ({
  shell: { openExternal: (url: string) => openExternal(url) }
}))

import { markContextualLinkRouterReady } from './contextual-link-relay'
import { installPrivilegedWindowNavigationPolicy } from './privileged-window-navigation'

describe('privileged window navigation policy', () => {
  function createFixture(currentUrl: string, options: { routesLinks?: boolean } = {}) {
    const handlers = new Map<string, (...args: unknown[]) => void>()
    const popupHandlers: ((details: { url: string }) => unknown)[] = []
    const contents = {
      id: 1,
      getURL: () => currentUrl,
      isDestroyed: () => false,
      send: vi.fn(),
      setWindowOpenHandler: vi.fn((handler: (details: { url: string }) => unknown) => {
        popupHandlers.push(handler)
      }),
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        handlers.set(event, handler)
      })
    }
    if (options.routesLinks) {
      markContextualLinkRouterReady(contents)
    }
    installPrivilegedWindowNavigationPolicy(contents as never)
    return {
      contents,
      windowOpen(url: string) {
        const handler = popupHandlers[0]
        if (!handler) {
          throw new Error('no window-open handler was registered')
        }
        return handler({ url })
      },
      willNavigate(url: string) {
        const event = { preventDefault: vi.fn() }
        const handler = handlers.get('will-navigate')
        // Assert handler presence or missing navigation guards pass allow-cases vacuously.
        if (!handler) {
          throw new Error('no will-navigate handler was registered')
        }
        handler(event, url)
        return event
      },
      fire(event: string, ...args: unknown[]) {
        const handler = handlers.get(event)
        if (!handler) {
          throw new Error(`no ${event} handler was registered`)
        }
        handler(...args)
      },
      subscribesTo(event: string): boolean {
        return handlers.has(event)
      }
    }
  }

  beforeEach(() => {
    openExternal.mockClear()
  })

  it('lets the packaged renderer document reload itself', () => {
    const appUrl =
      'file:///Applications/Orca.app/Contents/Resources/app.asar/out/renderer/index.html'
    const event = createFixture(appUrl).willNavigate(appUrl)

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('still blocks and hands off an external http target', () => {
    const appUrl =
      'file:///Applications/Orca.app/Contents/Resources/app.asar/out/renderer/index.html'
    const event = createFixture(appUrl).willNavigate('https://example.com/')

    expect(event.preventDefault).toHaveBeenCalled()
    expect(openExternal).toHaveBeenCalledWith('https://example.com/')
  })

  it('lets the dev renderer origin navigate but blocks foreign documents', () => {
    const fixture = createFixture('http://localhost:5173/')

    expect(
      fixture.willNavigate('http://localhost:5173/index.html').preventDefault
    ).not.toHaveBeenCalled()
    expect(fixture.willNavigate('https://example.com/').preventDefault).toHaveBeenCalled()
    expect(
      fixture.willNavigate('blob:http://localhost:5173/attacker-document').preventDefault
    ).toHaveBeenCalled()
  })

  // The exact packaged file host/path defines privilege; foreign hosts and copied paths under other schemes must fail.
  it('blocks a foreign file host and a data: URL that reuse the renderer path', () => {
    const appUrl =
      'file:///Applications/Orca.app/Contents/Resources/app.asar/out/renderer/index.html'
    const fixture = createFixture(appUrl)

    expect(
      fixture.willNavigate(
        'file://evil.example/Applications/Orca.app/Contents/Resources/app.asar/out/renderer/index.html'
      ).preventDefault
    ).toHaveBeenCalled()
    expect(
      fixture.willNavigate('data:text/html,<script>1</script>').preventDefault
    ).toHaveBeenCalled()
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('still blocks navigation to an unrelated local file', () => {
    const appUrl =
      'file:///Applications/Orca.app/Contents/Resources/app.asar/out/renderer/index.html'
    const event = createFixture(appUrl).willNavigate('file:///Users/someone/.ssh/id_rsa')

    expect(event.preventDefault).toHaveBeenCalled()
    expect(openExternal).not.toHaveBeenCalled()
  })

  // The window owns the link-routing preference, so main must hand web links over instead of
  // opening the OS browser behind the user's back.
  it('relays an external navigation to the window router instead of the OS browser', () => {
    const fixture = createFixture(
      'file:///Applications/Orca.app/Contents/Resources/app.asar/out/renderer/index.html',
      { routesLinks: true }
    )

    const event = fixture.willNavigate('https://example.com/')

    expect(event.preventDefault).toHaveBeenCalled()
    expect(fixture.contents.send).toHaveBeenCalledWith(
      'link:openContextual',
      'https://example.com/'
    )
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('relays a popup request to the window router', () => {
    const fixture = createFixture(
      'file:///Applications/Orca.app/Contents/Resources/app.asar/out/renderer/index.html',
      { routesLinks: true }
    )

    expect(fixture.windowOpen('https://example.com/')).toEqual({ action: 'deny' })
    expect(fixture.contents.send).toHaveBeenCalledWith(
      'link:openContextual',
      'https://example.com/'
    )
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('still opens the OS browser when the window announces no router', () => {
    const fixture = createFixture(
      'file:///Applications/Orca.app/Contents/Resources/app.asar/out/renderer/index.html'
    )

    expect(fixture.windowOpen('https://example.com/')).toEqual({ action: 'deny' })
    expect(openExternal).toHaveBeenCalledWith('https://example.com/')
    expect(fixture.contents.send).not.toHaveBeenCalled()
  })

  // Chromium emits did-start-navigation before the throttle that emits will-navigate, so clearing
  // readiness there would disarm the relay for the handler that cancels this very navigation.
  it('clears readiness only once a navigation commits', () => {
    const fixture = createFixture(
      'file:///Applications/Orca.app/Contents/Resources/app.asar/out/renderer/index.html',
      { routesLinks: true }
    )

    expect(fixture.subscribesTo('did-start-navigation')).toBe(false)
    expect(fixture.subscribesTo('did-navigate')).toBe(true)

    const event = fixture.willNavigate('https://example.com/')

    expect(event.preventDefault).toHaveBeenCalled()
    expect(fixture.contents.send).toHaveBeenCalledWith(
      'link:openContextual',
      'https://example.com/'
    )
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('forgets the router once a new document commits, and relays again until it re-announces', () => {
    const fixture = createFixture(
      'file:///Applications/Orca.app/Contents/Resources/app.asar/out/renderer/index.html',
      { routesLinks: true }
    )

    fixture.fire('did-navigate', {}, 'file:///next-document.html', 200, 'OK')
    expect(fixture.windowOpen('https://example.com/')).toEqual({ action: 'deny' })

    expect(fixture.contents.send).not.toHaveBeenCalled()
    expect(openExternal).toHaveBeenCalledWith('https://example.com/')
  })

  it('forgets the router when the renderer dies', () => {
    const fixture = createFixture(
      'file:///Applications/Orca.app/Contents/Resources/app.asar/out/renderer/index.html',
      { routesLinks: true }
    )

    fixture.fire('render-process-gone', {}, { reason: 'crashed' })
    fixture.windowOpen('https://example.com/')

    expect(fixture.contents.send).not.toHaveBeenCalled()
    expect(openExternal).toHaveBeenCalledWith('https://example.com/')
  })
})
