// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import type { ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  authStatus: {
    activeProfileId: 'profile-a',
    cloud: { cloudProfileId: 'cloud-a', userId: 'user-a' },
    configured: true,
    state: 'connected'
  } as Record<string, unknown>,
  closePage: vi.fn(),
  connect: vi.fn(),
  confirm: vi.fn(),
  refreshAuth: vi.fn(),
  rpc: vi.fn(),
  settings: {
    artifactSharingEnabled: true,
    skipDeleteArtifactConfirm: false
  } as Record<string, unknown> | null,
  updateSettings: vi.fn(),
  openSettingsPage: vi.fn(),
  openSettingsTarget: vi.fn(),
  resolvePartition: vi.fn(),
  writeClipboardText: vi.fn(),
  openUrl: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn()
}))

// LOCAL(nplez1): #234 routes share links through the in-app router, not the shell bridge.
const { openAppHttpLink } = vi.hoisted(() => ({ openAppHttpLink: vi.fn() }))
vi.mock('@/lib/browser/navigation/app-http-link-open', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  openAppHttpLink
}))
vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError }
}))

vi.mock('@/components/dismiss/confirmation/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => mocks.confirm
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: mocks.rpc
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector(storeState()),
    { getState: storeState }
  )
}))

function storeState(): Record<string, unknown> {
  return {
    closeArtifactsPage: mocks.closePage,
    connectCurrentOrcaProfile: mocks.connect,
    orcaProfileAuthStatus: mocks.authStatus,
    refreshCurrentOrcaProfileAuth: mocks.refreshAuth,
    settings: mocks.settings,
    updateSettings: mocks.updateSettings,
    openSettingsPage: mocks.openSettingsPage,
    openSettingsTarget: mocks.openSettingsTarget
  }
}

import ArtifactsPage from './ArtifactsPage'

describe('ArtifactsPage', () => {
  beforeEach(() => {
    mocks.authStatus = {
      activeProfileId: 'profile-a',
      cloud: { cloudProfileId: 'cloud-a', userId: 'user-a' },
      configured: true,
      state: 'connected'
    }
    mocks.closePage.mockReset()
    mocks.connect.mockReset()
    mocks.confirm.mockReset()
    mocks.refreshAuth.mockReset()
    mocks.rpc.mockReset()
    mocks.settings = { artifactSharingEnabled: true, skipDeleteArtifactConfirm: false }
    mocks.updateSettings.mockReset().mockResolvedValue(undefined)
    mocks.openSettingsPage.mockReset()
    mocks.openSettingsTarget.mockReset()
    mocks.resolvePartition.mockReset().mockResolvedValue('persist:orca-default')
    mocks.writeClipboardText.mockReset().mockResolvedValue(undefined)
    mocks.openUrl.mockReset().mockResolvedValue(undefined)
    mocks.toastSuccess.mockReset()
    mocks.toastError.mockReset()
    Object.assign(window, {
      api: {
        browser: { sessionResolvePartition: mocks.resolvePartition },
        ui: { writeClipboardText: mocks.writeClipboardText },
        shell: { openUrl: mocks.openUrl }
      }
    })
    mocks.rpc.mockResolvedValue({
      status: 'ok',
      value: {
        artifacts: [
          {
            artifact: {
              byteSize: 1024,
              createdAt: '2026-08-01T12:00:00.000Z',
              deletedAt: null,
              expiresAt: '2026-09-01T12:00:00.000Z',
              originalFileName: 'report.html',
              renderedContentType: 'text/html',
              slug: 'report-123',
              sourceContentType: 'text/html',
              title: 'Quarterly report',
              updatedAt: '2026-08-02T12:00:00.000Z',
              version: 1
            },
            shareUrl: 'https://share.onorca.dev/a/report-123'
          }
        ]
      }
    })
  })

  afterEach(cleanup)

  it('renders the selected artifact in a right drawer with copy link as the primary action', async () => {
    render(<ArtifactsPage />)

    const row = await screen.findByRole('button', { name: /Quarterly report/ })
    expect(row).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 2, name: 'Quarterly report' })).toBeNull()
    const title = screen.getByRole('heading', { level: 1, name: 'Artifacts' })
    expect(title).toHaveClass('text-base', 'font-semibold', 'leading-8')
    expect(title.closest('header')).toHaveClass('px-3', 'pb-3', 'md:px-5')
    expect(screen.getByRole('main')).toHaveClass('pt-5', 'md:pt-6')
    expect(screen.queryByRole('button', { name: 'Close artifacts' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Refresh' })).toHaveClass('border', 'border-border')

    fireEvent.click(row)
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Quarterly report' })
    ).toBeInTheDocument()
    expect(document.querySelector('[data-slot="sheet-content"]')).toHaveClass(
      'w-[min(96rem,calc(100vw-var(--mac-traffic-lights-width,0px)))]'
    )
    // Drawer actions must stay inset beyond the fixed Windows/Linux controls overlay.
    expect(
      screen
        .getByRole('button', { name: 'Close' })
        .closest('.pr-\\[max\\(1rem\\,var\\(--window-controls-width\\,0px\\)\\)\\]')
    ).not.toBeNull()
    const copyButton = screen.getByRole('button', { name: 'Copy link' })
    expect(copyButton).toHaveAttribute('data-variant', 'default')
    expect(copyButton.parentElement).toHaveAttribute('aria-label', 'Artifact actions')
    expect(screen.getByRole('button', { name: 'Open in browser' })).toHaveAttribute(
      'data-variant',
      'ghost'
    )
    expect(screen.queryByRole('button', { name: 'Delete artifact' })).toBeNull()
    expect(screen.getByRole('button', { name: 'More artifact actions' })).toBeInTheDocument()

    await waitFor(() => {
      const preview = document.querySelector('webview[aria-label="Artifact preview"]')
      expect(preview).toHaveAttribute('partition', 'persist:orca-default')
      expect(preview).toHaveAttribute('src', 'https://share.onorca.dev/a/report-123?embed=1')
    })

    fireEvent.click(copyButton)
    await waitFor(() =>
      expect(mocks.writeClipboardText).toHaveBeenCalledWith('https://share.onorca.dev/a/report-123')
    )
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Artifact link copied')

    fireEvent.click(screen.getByRole('button', { name: 'Open in browser' }))
    expect(openAppHttpLink).toHaveBeenCalledWith('https://share.onorca.dev/a/report-123')
  })

  it('shows a fallback when the desktop preview session is unavailable', async () => {
    mocks.resolvePartition.mockResolvedValue(null)
    render(<ArtifactsPage />)

    fireEvent.click(await screen.findByRole('button', { name: /Quarterly report/ }))
    expect(await screen.findByText('Preview unavailable')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Open in browser' })).toBeEnabled()
  })

  it('never renders artifacts loaded for a previous account', async () => {
    let resolveFirst!: (value: unknown) => void
    mocks.rpc.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFirst = resolve
      })
    )
    const view = render(<ArtifactsPage />)

    mocks.authStatus = {
      activeProfileId: 'profile-b',
      cloud: { cloudProfileId: 'cloud-b', userId: 'user-b' },
      configured: true,
      state: 'connected'
    }
    mocks.rpc.mockResolvedValueOnce({ status: 'ok', value: { artifacts: [] } })
    view.rerender(<ArtifactsPage />)
    await act(async () => {
      resolveFirst({
        status: 'ok',
        value: {
          artifacts: [
            {
              artifact: {
                byteSize: 1,
                createdAt: '2026-08-01T12:00:00.000Z',
                deletedAt: null,
                expiresAt: '2026-09-01T12:00:00.000Z',
                originalFileName: 'account-a-secret.html',
                renderedContentType: 'text/html',
                slug: 'account-a-secret',
                sourceContentType: 'text/html',
                title: 'Account A secret',
                updatedAt: '2026-08-02T12:00:00.000Z',
                version: 1
              },
              shareUrl: 'https://share.onorca.dev/a/account-a-secret'
            }
          ]
        }
      })
    })

    await screen.findByText('No shared artifacts')
    expect(screen.queryByText('Account A secret')).not.toBeInTheDocument()
  })

  it('does not apply a completed deletion to a new account', async () => {
    let resolveDelete!: (value: unknown) => void
    mocks.confirm.mockResolvedValue(true)
    mocks.rpc.mockResolvedValueOnce({
      status: 'ok',
      value: { artifacts: [artifactListItem('Shared slug A', 'shared-slug')] }
    })
    mocks.rpc.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveDelete = resolve
      })
    )
    const view = render(<ArtifactsPage />)

    await screen.findAllByText('Shared slug A')
    await deleteFirstArtifactFromDrawerMenu()
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(2))

    mocks.authStatus = {
      activeProfileId: 'profile-b',
      cloud: { cloudProfileId: 'cloud-b', userId: 'user-b' },
      configured: true,
      state: 'connected'
    }
    mocks.rpc.mockResolvedValueOnce({
      status: 'ok',
      value: { artifacts: [artifactListItem('Shared slug B', 'shared-slug')] }
    })
    view.rerender(<ArtifactsPage />)
    await act(async () => {
      resolveDelete({ status: 'ok', value: undefined })
    })

    expect(await screen.findByRole('button', { name: /Shared slug B/ })).toBeInTheDocument()
  })
})

/** Opens the drawer from the first rendered row, then deletes through the drawer's action menu. */
async function deleteFirstArtifactFromDrawerMenu(): Promise<void> {
  const row = document.querySelector('[data-slot="context-menu-trigger"]')
  if (!(row instanceof HTMLElement)) {
    throw new Error('Expected an artifact row')
  }
  await userEvent.click(row)
  await userEvent.click(screen.getByRole('button', { name: 'More artifact actions' }))
  await userEvent.click(screen.getByRole('menuitem', { name: 'Delete artifact' }))
}

function artifactListItem(title: string, slug: string): Record<string, unknown> {
  return {
    artifact: {
      byteSize: 1,
      createdAt: '2026-08-01T12:00:00.000Z',
      deletedAt: null,
      expiresAt: '2026-09-01T12:00:00.000Z',
      originalFileName: `${slug}.html`,
      renderedContentType: 'text/html',
      slug,
      sourceContentType: 'text/html',
      title,
      updatedAt: '2026-08-02T12:00:00.000Z',
      version: 1
    },
    shareUrl: `https://share.onorca.dev/a/${slug}`
  }
}
