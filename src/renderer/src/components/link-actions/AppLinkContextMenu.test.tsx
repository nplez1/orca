// @vitest-environment happy-dom
import type { ReactElement, ReactNode } from 'react'
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

describe('AppLinkContextMenu link resolution', () => {
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

  function rightClickOn(node: ReactElement, targetText?: string): void {
    render(
      <>
        <AppLinkContextMenu />
        {node}
      </>
    )
    fireEvent.contextMenu(targetText ? screen.getByText(targetText) : screen.getByTestId('target'))
  }

  it.each([
    [
      'a mailto: link',
      <a key="m" data-testid="target" href="mailto:dev@example.com">
        mail
      </a>
    ],
    [
      'a file: link',
      <a key="f" data-testid="target" href="file:///tmp/notes.md">
        notes
      </a>
    ],
    [
      'a same-page fragment',
      <a key="h" data-testid="target" href="#section">
        section
      </a>
    ],
    [
      'a relative link',
      <a key="r" data-testid="target" href="/docs">
        docs
      </a>
    ],
    [
      'an empty href',
      <a key="e" data-testid="target" href="">
        empty
      </a>
    ]
  ])('leaves %s to the browser default menu', (_label, node) => {
    rightClickOn(node)

    expect(screen.queryByTestId('link-context-menu')).toBeNull()
  })

  // A cancelled DOM contextmenu suppresses Electron's own menu, which the editor needs.
  it('leaves links inside an editable surface to the editor', () => {
    rightClickOn(
      <div contentEditable suppressContentEditableWarning>
        <a href="https://example.com/docs">docs</a>
      </div>,
      'docs'
    )

    expect(screen.queryByTestId('link-context-menu')).toBeNull()
  })

  // Control: the same anchor outside an editable surface does get the link menu.
  it('offers the menu for the same link outside an editable surface', () => {
    rightClickOn(
      <div>
        <a href="https://example.com/docs">docs</a>
      </div>,
      'docs'
    )

    expect(screen.getByTestId('link-context-menu')).toBeTruthy()
  })

  it('offers the menu for a button that declares data-link-url', () => {
    rightClickOn(
      <button type="button" data-testid="target" data-link-url="https://example.com/pr/7">
        Open in browser
      </button>
    )

    fireEvent.click(menuItem('Open in System Browser'))

    expect(mocks.openContextualHttpLink).toHaveBeenCalledWith('https://example.com/pr/7', {
      worktreeId: 'wt-1',
      forceDestination: 'system'
    })
  })

  // A declared link outranks the in-app route its row wraps, which would otherwise win by proximity.
  it('prefers a declared link over a wrapping non-web anchor', () => {
    rightClickOn(
      <a href="/settings">
        <button type="button" data-testid="target" data-link-url="https://example.com/issue/9">
          Issue 9
        </button>
      </a>
    )

    fireEvent.click(menuItem('Open in Orca Browser'))

    expect(mocks.openContextualHttpLink).toHaveBeenCalledWith('https://example.com/issue/9', {
      worktreeId: 'wt-1',
      forceDestination: 'orca'
    })
  })

  // The innermost claim is the most specific one, so a nested anchor still names its own address.
  it('prefers a nested web anchor over the row that declares a link', () => {
    rightClickOn(
      <div data-link-url="https://example.com/row">
        <a href="https://example.com/nested">nested</a>
      </div>,
      'nested'
    )

    fireEvent.click(menuItem('Open in System Browser'))

    expect(mocks.openContextualHttpLink).toHaveBeenCalledWith('https://example.com/nested', {
      worktreeId: 'wt-1',
      forceDestination: 'system'
    })
  })

  it('ignores a declared value that is not a web address', () => {
    rightClickOn(
      <button type="button" data-testid="target" data-link-url="file:///tmp/notes.md">
        Notes
      </button>
    )

    expect(screen.queryByTestId('link-context-menu')).toBeNull()
  })
})
