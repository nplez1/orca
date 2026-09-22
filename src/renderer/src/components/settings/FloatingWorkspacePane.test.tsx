// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { resetRendererAppPlatformCacheForTests } from '@/lib/renderer-app-platform'
import { FloatingWorkspacePane } from './FloatingWorkspacePane'

const FLOATING_WORKSPACE_DIRECTORY = '/Users/example/.orca/floating-workspace'

const { getFloatingTerminalCwd, openInFileManagerMock, pickFloatingWorkspaceDirectory } =
  vi.hoisted(() => ({
    getFloatingTerminalCwd: vi.fn(),
    openInFileManagerMock: vi.fn(),
    pickFloatingWorkspaceDirectory: vi.fn()
  }))

type PaneSettings = Pick<
  GlobalSettings,
  'floatingTerminalCwd' | 'floatingTerminalEnabled' | 'floatingTerminalTriggerLocation'
>

function renderPane(settings: Partial<PaneSettings> = {}): void {
  render(
    <FloatingWorkspacePane
      settings={{
        floatingTerminalCwd: '',
        floatingTerminalEnabled: true,
        floatingTerminalTriggerLocation: 'floating-button',
        ...settings
      }}
      updateSettings={vi.fn()}
    />
  )
}

describe('FloatingWorkspacePane terminal directory', () => {
  beforeEach(() => {
    // Why: main resolves whatever setting it is handed to the real directory, as the IPC does.
    getFloatingTerminalCwd.mockImplementation(async (args?: { path?: string }) =>
      args?.path ? args.path : FLOATING_WORKSPACE_DIRECTORY
    )
    openInFileManagerMock.mockResolvedValue({ ok: true })
    pickFloatingWorkspaceDirectory.mockResolvedValue(null)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        app: { getFloatingTerminalCwd, pickFloatingWorkspaceDirectory },
        shell: { openInFileManager: openInFileManagerMock },
        platform: { get: () => ({ platform: 'darwin' }) }
      }
    })
    resetRendererAppPlatformCacheForTests()
  })

  afterEach(() => {
    cleanup()
  })

  it('shows the floating-workspace folder the blank default resolves to', async () => {
    renderPane()

    await waitFor(() => {
      expect(screen.getByDisplayValue(FLOATING_WORKSPACE_DIRECTORY)).toBeTruthy()
    })
  })

  it('shows a chosen directory instead of the folder', async () => {
    renderPane({ floatingTerminalCwd: '/Users/example/notes' })

    await waitFor(() => {
      expect(screen.getByDisplayValue('/Users/example/notes')).toBeTruthy()
    })
  })

  it('reveals the resolved folder in the platform file manager', async () => {
    renderPane()

    const revealButton = await screen.findByRole('button', { name: 'Show in Finder' })
    await waitFor(() => {
      expect(revealButton.hasAttribute('disabled')).toBe(false)
    })
    fireEvent.click(revealButton)

    await waitFor(() => {
      expect(openInFileManagerMock).toHaveBeenCalledWith(FLOATING_WORKSPACE_DIRECTORY)
    })
  })
})
