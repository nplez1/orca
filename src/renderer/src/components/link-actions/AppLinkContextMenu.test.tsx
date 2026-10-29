// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const storeState: { activeWorktreeId: string | null } = { activeWorktreeId: 'wt-1' }
  return {
    openContextualHttpLink: vi.fn(),
    writeClipboardText: vi.fn(),
    storeState
  }
})

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: { activeWorktreeId: string | null }) => unknown) =>
    selector(mocks.storeState)
}))

vi.mock('@/lib/contextual-http-link', () => ({
  openContextualHttpLink: mocks.openContextualHttpLink
}))

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children, open }: { children: ReactNode; open: boolean }) => (
    <>{open ? children : null}</>
  ),
  PopoverAnchor: () => null,
  PopoverContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="link-context-menu">{children}</div>
  )
}))

import { AppLinkContextMenu } from './AppLinkContextMenu'

function renderWithLink(href: string): HTMLElement {
  render(
    <>
      <AppLinkContextMenu />
      <a href={href}>link text</a>
    </>
  )
  const anchor = screen.getByText('link text')
  fireEvent.contextMenu(anchor, { clientX: 40, clientY: 60 })
  return anchor
}

function menuItem(label: string): HTMLElement {
  return screen.getByRole('button', { name: label })
}

describe('AppLinkContextMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.storeState.activeWorktreeId = 'wt-1'
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ui: { writeClipboardText: mocks.writeClipboardText } }
    })
  })

  afterEach(() => {
    cleanup()
    Reflect.deleteProperty(window, 'api')
  })

  it('offers Orca, system, and copy for a web link', () => {
    renderWithLink('https://example.com/docs')

    expect(screen.getByTestId('link-context-menu')).toBeTruthy()
    expect(menuItem('Open in Orca Browser')).toBeTruthy()
    expect(menuItem('Open in System Browser')).toBeTruthy()
    expect(menuItem('Copy Link')).toBeTruthy()
  })

  it('opens the link in Orca when that row is chosen', () => {
    renderWithLink('https://example.com/docs')

    fireEvent.click(menuItem('Open in Orca Browser'))

    expect(mocks.openContextualHttpLink).toHaveBeenCalledWith('https://example.com/docs', {
      worktreeId: 'wt-1',
      forceDestination: 'orca'
    })
  })

  it('hands the link to the system browser when that row is chosen', () => {
    renderWithLink('https://example.com/docs')

    fireEvent.click(menuItem('Open in System Browser'))

    expect(mocks.openContextualHttpLink).toHaveBeenCalledWith('https://example.com/docs', {
      worktreeId: 'wt-1',
      forceDestination: 'system'
    })
  })

  it('copies the link address', async () => {
    renderWithLink('https://example.com/docs')

    fireEvent.click(menuItem('Copy Link'))

    await waitFor(() =>
      expect(mocks.writeClipboardText).toHaveBeenCalledWith('https://example.com/docs')
    )
  })

  // Without a workspace there is no in-app destination, so offering the row would be a lie.
  it('hides the Orca row when no workspace is active', () => {
    mocks.storeState.activeWorktreeId = null

    renderWithLink('https://example.com/docs')

    expect(screen.queryByText('Open in Orca Browser')).toBeNull()
    expect(menuItem('Open in System Browser')).toBeTruthy()
  })

  it('leaves non-web links to the browser default menu', () => {
    render(
      <>
        <AppLinkContextMenu />
        <a href="#section">anchor text</a>
      </>
    )
    fireEvent.contextMenu(screen.getByText('anchor text'))

    expect(screen.queryByTestId('link-context-menu')).toBeNull()
  })
})
