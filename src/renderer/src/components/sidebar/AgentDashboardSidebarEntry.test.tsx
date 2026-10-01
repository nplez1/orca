// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'

const mocks = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  openAgentDashboardPage: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.state)
}))

vi.mock('@/components/dashboard/useAgentBucketCounts', () => ({
  useAgentBucketCounts: () => ({ attention: 0, working: 0, done: 0, idle: 0 })
}))

import AgentDashboardSidebarEntry from './AgentDashboardSidebarEntry'

function setEntryState({
  activeView = 'terminal',
  settings = {}
}: {
  activeView?: string
  settings?: Partial<GlobalSettings>
} = {}): void {
  mocks.state = {
    settings,
    activeView,
    openAgentDashboardPage: mocks.openAgentDashboardPage
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
  mocks.openAgentDashboardPage.mockReset()
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  container = null
  vi.clearAllMocks()
})

describe('AgentDashboardSidebarEntry', () => {
  it('shows as selected while the dashboard view is active', async () => {
    setEntryState({ activeView: 'dashboard' })
    const button = await renderEntry()

    expect(button.getAttribute('aria-current')).toBe('page')
    expect(button.getAttribute('data-current')).toBe('true')
    expect(button.className).toContain('bg-worktree-sidebar-accent')
  })

  it('reads as unselected for any other view', async () => {
    setEntryState({ activeView: 'terminal' })
    const button = await renderEntry()

    expect(button.getAttribute('aria-current')).toBeNull()
    expect(button.getAttribute('data-current')).toBeNull()
    expect(button.className).not.toContain('bg-worktree-sidebar-accent')
  })

  it('opens the dashboard view when clicked', async () => {
    setEntryState({ activeView: 'terminal' })
    const button = await renderEntry()

    act(() => button.click())

    expect(mocks.openAgentDashboardPage).toHaveBeenCalledOnce()
  })
})
