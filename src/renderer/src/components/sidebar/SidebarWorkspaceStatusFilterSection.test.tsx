// @vitest-environment happy-dom

/**
 * The Status filter is a Radix submenu whose checkbox items must keep the
 * panel open while several statuses are toggled, and whose value label reports
 * hidden statuses the user can actually see. Both are invisible to typecheck.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted((): { state: Record<string, unknown> } => ({ state: {} }))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.state)
}))

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import SidebarWorkspaceStatusFilterSection from './SidebarWorkspaceStatusFilterSection'

const STATUSES = [
  { id: 'todo', label: 'Todo', color: 'neutral', icon: 'circle' },
  { id: 'completed', label: 'Done', color: 'conductor-done', icon: 'conductor-done' }
]

let container: HTMLDivElement
let root: Root
let setHiddenWorkspaceStatusIds: ReturnType<typeof vi.fn>

function setState(overrides: Record<string, unknown> = {}): void {
  setHiddenWorkspaceStatusIds = vi.fn()
  mocks.state = {
    workspaceStatuses: STATUSES,
    hiddenWorkspaceStatusIds: [],
    setHiddenWorkspaceStatusIds,
    ...overrides
  }
}

function render(): void {
  act(() => {
    root.render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>Options</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Sort by</DropdownMenuItem>
          <SidebarWorkspaceStatusFilterSection />
        </DropdownMenuContent>
      </DropdownMenu>
    )
  })
}

/** Radix opens submenus and fires item selection on pointer events. */
function activate(element: HTMLElement): void {
  act(() => {
    element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }))
    element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse' }))
    element.click()
  })
}

function openSubmenu(): void {
  const trigger = document.querySelector<HTMLElement>('[data-slot="dropdown-menu-sub-trigger"]')
  if (!trigger) {
    throw new Error('sub-trigger not rendered')
  }
  activate(trigger)
}

function statusItems(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]'))
}

function itemFor(label: string): HTMLElement {
  const item = statusItems().find((element) => element.textContent?.includes(label))
  if (!item) {
    throw new Error(`no checkbox item for ${label}`)
  }
  return item
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.setPointerCapture ??= () => {}
  Element.prototype.releasePointerCapture ??= () => {}
  Element.prototype.scrollIntoView ??= () => {}
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  }
  setState()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('SidebarWorkspaceStatusFilterSection', () => {
  it('hides itself when no statuses are defined', () => {
    setState({ workspaceStatuses: [] })
    render()

    expect(document.querySelector('[data-slot="dropdown-menu-sub-trigger"]')).toBeNull()
  })

  it('lists every status as checked while none is hidden', () => {
    render()
    openSubmenu()

    const items = statusItems()
    expect(items).toHaveLength(STATUSES.length)
    expect(items.map((item) => item.getAttribute('aria-checked'))).toEqual(['true', 'true'])
    expect(document.body.textContent).toContain('All statuses')
  })

  it('adds a status to the hidden list when it is unchecked', () => {
    render()
    openSubmenu()

    activate(itemFor('Done'))

    expect(setHiddenWorkspaceStatusIds).toHaveBeenCalledWith(['completed'])
  })

  it('removes a status from the hidden list when it is rechecked', () => {
    setState({ hiddenWorkspaceStatusIds: ['completed'] })
    render()
    openSubmenu()

    expect(itemFor('Done').getAttribute('aria-checked')).toBe('false')
    activate(itemFor('Done'))

    expect(setHiddenWorkspaceStatusIds).toHaveBeenCalledWith([])
  })

  it('reports the hidden count in the trigger row', () => {
    setState({ hiddenWorkspaceStatusIds: ['completed'] })
    render()

    expect(document.body.textContent).toContain('1 hidden')
  })

  it('shows all statuses again from the panel header', () => {
    setState({ hiddenWorkspaceStatusIds: ['completed'] })
    render()
    openSubmenu()

    const showAll = Array.from(document.querySelectorAll<HTMLElement>('button')).find((button) =>
      button.textContent?.includes('Show all')
    )
    if (!showAll) {
      throw new Error('Show all button not rendered')
    }
    activate(showAll)

    expect(setHiddenWorkspaceStatusIds).toHaveBeenCalledWith([])
  })
})
