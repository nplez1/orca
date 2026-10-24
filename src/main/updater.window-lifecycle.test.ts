import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createUpdaterMainWindow } from './updater-test-main-window'
import { loadUpdaterModule, warmUpdaterModule } from './updater-test-module-loader'

const { appMock, autoUpdaterMock, moduleFactories, resetUpdaterMocks } = await vi.hoisted(
  async () => (await import('./updater-test-harness')).createUpdaterMocks()
)

vi.mock('electron', () => moduleFactories.electron())
vi.mock('electron-updater', () => moduleFactories.electronUpdater())
vi.mock('./electron-updater-loader', () => moduleFactories.electronUpdaterLoader())
vi.mock('./ipc/pty/kill-all', () => moduleFactories.ptyKillAll())
vi.mock('./linux-update-package-type', () => moduleFactories.linuxUpdatePackageType())
vi.mock('./updater-lifecycle-diagnostics', () => moduleFactories.updaterLifecycleDiagnostics())
vi.mock('./updater-changelog', () => moduleFactories.updaterChangelog())
vi.mock('./updater-nudge', () => moduleFactories.updaterNudge())
vi.mock('./update-install-exit-watchdog', () => moduleFactories.updateInstallExitWatchdog())
vi.mock('./updater-prerelease-feed', () => moduleFactories.updaterPrereleaseFeed())
vi.mock('./local-builds/local-build-switch', () => moduleFactories.localBuildSwitch())
vi.mock('./local-builds/local-build-feed-server', () => moduleFactories.localBuildFeedServer())

const NOT_AVAILABLE = { state: 'not-available', userInitiated: true }

warmUpdaterModule()

describe('updater main-window lifecycle', () => {
  beforeEach(() => {
    resetUpdaterMocks()
    // Why: an unpackaged app answers a menu check from state alone, so the test drives the send path
    // with no feed, download or install machinery in the way.
    appMock.isPackaged = false
  })

  it('records a status instead of throwing when the window closed before the event', async () => {
    const send = vi.fn()
    const mainWindow = createUpdaterMainWindow(send)
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()
    setupAutoUpdater(mainWindow, {})

    mainWindow.close()

    expect(() => checkForUpdatesFromMenu()).not.toThrow()
    expect(send).not.toHaveBeenCalled()
  })

  it('skips the send while only the renderer is gone', async () => {
    const send = vi.fn()
    const mainWindow = createUpdaterMainWindow(send)
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()
    setupAutoUpdater(mainWindow, {})

    mainWindow.destroyWebContents()

    expect(() => checkForUpdatesFromMenu()).not.toThrow()
    expect(send).not.toHaveBeenCalled()
  })

  it('swallows a send that fails as the window is being torn down', async () => {
    const send = vi.fn(() => {
      throw new Error('Object has been destroyed')
    })
    const mainWindow = createUpdaterMainWindow(send)
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()
    setupAutoUpdater(mainWindow, {})

    expect(() => checkForUpdatesFromMenu()).not.toThrow()
    expect(send).toHaveBeenCalledWith('updater:status', NOT_AVAILABLE)
  })

  it('replays the status that landed while no window was bound to the replacement window', async () => {
    const send = vi.fn()
    const first = createUpdaterMainWindow(send)
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()
    setupAutoUpdater(first, {})
    first.close()

    checkForUpdatesFromMenu()

    const replacementSend = vi.fn()
    const replacement = createUpdaterMainWindow(replacementSend)
    setupAutoUpdater(replacement, {})

    expect(replacementSend).toHaveBeenCalledWith('updater:status', NOT_AVAILABLE)
    expect(send).not.toHaveBeenCalled()
  })

  it('keeps the untouched default status from being replayed on bind', async () => {
    const send = vi.fn()
    const { setupAutoUpdater } = await loadUpdaterModule()

    setupAutoUpdater(createUpdaterMainWindow(send), {})

    expect(send).not.toHaveBeenCalled()
  })

  it('replays a recorded idle, which the renderer cannot distinguish from the default', async () => {
    vi.useFakeTimers()
    // Why: only a packaged app wires the electron-updater handlers this settle path runs through.
    appMock.isPackaged = true
    const error = new Error('Unable to find latest version on GitHub')
    autoUpdaterMock.checkForUpdates.mockImplementation(() => {
      autoUpdaterMock.emit('checking-for-update')
      queueMicrotask(() => autoUpdaterMock.emit('error', error))
      return Promise.reject(error)
    })
    const first = createUpdaterMainWindow()
    const { setupAutoUpdater, checkForUpdates } = await loadUpdaterModule()
    setupAutoUpdater(first, { getLastUpdateCheckAt: () => Date.now() })

    checkForUpdates()
    await vi.advanceTimersByTimeAsync(0)

    first.close()
    const replacementSend = vi.fn()
    setupAutoUpdater(createUpdaterMainWindow(replacementSend), {})

    expect(replacementSend).toHaveBeenCalledWith('updater:status', { state: 'idle' })
  })

  it('keeps the newer window bound when the replaced one closes', async () => {
    const firstSend = vi.fn()
    const secondSend = vi.fn()
    const first = createUpdaterMainWindow(firstSend)
    const second = createUpdaterMainWindow(secondSend)
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()
    setupAutoUpdater(first, {})
    setupAutoUpdater(second, {})

    first.close()
    checkForUpdatesFromMenu()

    expect(secondSend).toHaveBeenCalledWith('updater:status', NOT_AVAILABLE)
    expect(firstSend).not.toHaveBeenCalled()
  })

  it('keeps the bound window when headless serve sets up without one', async () => {
    const send = vi.fn()
    const mainWindow = createUpdaterMainWindow(send)
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()
    setupAutoUpdater(mainWindow, {})

    setupAutoUpdater(null, {})
    checkForUpdatesFromMenu()

    expect(send).toHaveBeenCalledWith('updater:status', NOT_AVAILABLE)
  })
})
