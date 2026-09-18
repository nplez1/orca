// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'

const mocks = vi.hoisted(() => {
  const state: Record<string, unknown> = {}
  const listeners: { popoutOpen: ((open: boolean) => void) | null } = { popoutOpen: null }
  return {
    state,
    listeners,
    setAgentDashboardDrawerOpen: vi.fn(),
    openPopout: vi.fn(async () => undefined),
    closePopout: vi.fn(async () => undefined),
    getPopoutOpen: vi.fn(async () => false)
  }
})

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.state)
}))

vi.mock('@/components/dashboard/useAgentBucketCounts', () => ({
  useAgentBucketCounts: () => ({ attention: 0, working: 0, done: 0, idle: 0 })
}))

import AgentDashboardSidebarEntry from './AgentDashboardSidebarEntry'

function setEntryState({
  mode = 'in-window',
  drawerOpen = false
}: {
  mode?: GlobalSettings['experimentalAgentDashboardMode']
  drawerOpen?: boolean
} = {}): void {
  mocks.state = {
    settings: { ...getDefaultSettings('/tmp'), experimentalAgentDashboardMode: mode },
    agentDashboardDrawerOpen: drawerOpen,
    setAgentDashboardDrawerOpen: mocks.setAgentDashboardDrawerOpen
  }
}

let root: Root | null = null
let container: HTMLDivElement | null = null

async function renderEntry(): Promise<HTMLButtonElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<AgentDashboardSidebarEntry />)
  })
  const button = container.querySelector('button')
  if (!button) {
    throw new Error('dashboard sidebar entry not rendered')
  }
  return button
}

beforeEach(() => {
  mocks.listeners.popoutOpen = null
  mocks.getPopoutOpen.mockResolvedValue(false)
  Object.assign(window, {
    api: {
      dashboard: {
        openPopout: mocks.openPopout,
        closePopout: mocks.closePopout,
        getPopoutOpen: mocks.getPopoutOpen,
        onPopoutOpenChanged: (listener: (open: boolean) => void) => {
          mocks.listeners.popoutOpen = listener
          return () => {
            mocks.listeners.popoutOpen = null
          }
        }
      }
    }
  })
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  container = null
  vi.clearAllMocks()
})

describe('AgentDashboardSidebarEntry', () => {
  it('shows the in-window board as selected while the drawer is open', async () => {
    setEntryState({ mode: 'in-window', drawerOpen: true })
    const button = await renderEntry()

    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(button.getAttribute('data-current')).toBe('true')
    expect(button.className).toContain('bg-worktree-sidebar-accent')
  })

  it('reads as unselected and toggles the drawer in in-window mode', async () => {
    setEntryState({ mode: 'in-window', drawerOpen: false })
    const button = await renderEntry()

    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(button.getAttribute('data-current')).toBeNull()
    expect(button.className).not.toContain('bg-worktree-sidebar-accent')

    act(() => button.click())

    expect(mocks.setAgentDashboardDrawerOpen).toHaveBeenCalledWith(true)
    expect(mocks.openPopout).not.toHaveBeenCalled()
  })

  it('shows the pop-out as selected while its window is open', async () => {
    setEntryState({ mode: 'popout' })
    mocks.getPopoutOpen.mockResolvedValue(true)
    const button = await renderEntry()

    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(mocks.openPopout).not.toHaveBeenCalled()
  })

  it('hides the pop-out when the selected entry is clicked', async () => {
    setEntryState({ mode: 'popout' })
    mocks.getPopoutOpen.mockResolvedValue(true)
    const button = await renderEntry()

    act(() => button.click())

    expect(mocks.closePopout).toHaveBeenCalledOnce()
    expect(mocks.openPopout).not.toHaveBeenCalled()
  })

  it('opens the pop-out when the unselected entry is clicked', async () => {
    setEntryState({ mode: 'popout' })
    const button = await renderEntry()

    act(() => button.click())

    expect(mocks.openPopout).toHaveBeenCalledOnce()
    expect(mocks.closePopout).not.toHaveBeenCalled()
  })

  it('follows pop-out open and close transitions', async () => {
    setEntryState({ mode: 'popout' })
    const button = await renderEntry()

    await act(async () => mocks.listeners.popoutOpen?.(true))
    expect(button.getAttribute('aria-pressed')).toBe('true')

    await act(async () => mocks.listeners.popoutOpen?.(false))
    expect(button.getAttribute('aria-pressed')).toBe('false')
  })
})
