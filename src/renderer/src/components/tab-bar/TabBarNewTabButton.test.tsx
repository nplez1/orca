// @vitest-environment happy-dom

import { act, createElement, Fragment, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { getByRole, getByTestId, queryByTestId } from '@testing-library/dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { NEW_TAB_HOLD_TO_OPEN_MENU_MS, TabBarNewTabButton } from './TabBarNewTabButton'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

type ButtonTestHarness = {
  settings: {
    defaultTuiAgent: TuiAgent | 'blank' | null
    disabledTuiAgents: TuiAgent[]
  }
  detectedIds: TuiAgent[]
  structuredLaunchStatus: 'idle' | 'pending'
  onLaunchAgent: ReturnType<typeof vi.fn<(agent: TuiAgent) => void>>
  onOpenMenu: ReturnType<typeof vi.fn<() => void>>
}

const harness = vi.hoisted((): ButtonTestHarness => ({
  settings: {
    defaultTuiAgent: 'codex',
    disabledTuiAgents: []
  },
  detectedIds: ['claude', 'codex'],
  structuredLaunchStatus: 'idle',
  onLaunchAgent: vi.fn<(agent: TuiAgent) => void>(),
  onOpenMenu: vi.fn<() => void>()
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: { settings: ButtonTestHarness['settings'] }) => unknown) =>
    selector({ settings: harness.settings })
}))

vi.mock('@/hooks/useAgentDetectionTarget', () => ({
  useAgentDetectionTargetForWorktree: vi.fn(() => ({ kind: 'local' }))
}))

vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: vi.fn(() => ({ detectedIds: harness.detectedIds }))
}))

vi.mock('@/lib/structured-agent-session-launch', () => ({
  useStructuredAgentLaunchStatus: vi.fn(() => harness.structuredLaunchStatus)
}))

vi.mock('@/lib/agent-catalog', () => ({
  getAgentCatalog: () => [
    { id: 'claude', label: 'Claude' },
    { id: 'codex', label: 'Codex' }
  ],
  AgentIcon: () => null
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, vars?: Record<string, string>) =>
    Object.entries(vars ?? {}).reduce(
      (text, [key, value]) => text.replace(`{{${key}}}`, value),
      fallback
    )
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <span>{children}</span>
}))

// Radix portals and focus management do not run under happy-dom; keep only the
// structural contract the surface depends on — the trigger owns the menu.
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => (
    <span data-testid="dropdown-trigger">{children}</span>
  )
}))

let container: HTMLDivElement
let root: Root

/** Mirrors the tab bar: this component reports a hold via onOpenMenu and the open state returns. */
function ButtonHarness({ agentLaunchEnabled = true }: { agentLaunchEnabled?: boolean }): ReactNode {
  const [isMenuOpen, setMenuOpen] = useState(false)
  return createElement(
    Fragment,
    null,
    createElement(TabBarNewTabButton, {
      worktreeId: 'worktree-1',
      agentLaunchEnabled,
      isMenuOpen,
      onLaunchAgent: harness.onLaunchAgent,
      onOpenMenu: () => {
        harness.onOpenMenu()
        setMenuOpen(true)
      }
    }),
    // Test-only dismissal so the harness can model Radix closing an open menu.
    createElement('button', {
      'data-testid': 'dismiss-menu',
      onClick: () => setMenuOpen(false)
    })
  )
}

function renderButton(agentLaunchEnabled = true): void {
  act(() => {
    root.render(createElement(ButtonHarness, { agentLaunchEnabled }))
  })
}

function dispatchPointer(button: HTMLElement, type: string): void {
  act(() => {
    button.dispatchEvent(new Event(type, { bubbles: true }))
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  harness.settings.defaultTuiAgent = 'codex'
  harness.settings.disabledTuiAgents = []
  harness.detectedIds = ['claude', 'codex']
  harness.structuredLaunchStatus = 'idle'
  harness.onLaunchAgent.mockReset()
  harness.onOpenMenu.mockReset()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('TabBarNewTabButton', () => {
  it('launches the detected default agent from the primary control', () => {
    renderButton()

    act(() => getByRole(container, 'button', { name: 'Open Codex in a new tab' }).click())

    expect(harness.onLaunchAgent).toHaveBeenCalledExactlyOnceWith('codex')
  })

  it('opens the create menu when the primary control is held, without launching', () => {
    vi.useFakeTimers()
    renderButton()
    const primary = getByRole(container, 'button', { name: 'Open Codex in a new tab' })

    dispatchPointer(primary, 'pointerdown')
    act(() => vi.advanceTimersByTime(NEW_TAB_HOLD_TO_OPEN_MENU_MS))
    expect(harness.onOpenMenu).toHaveBeenCalledOnce()

    // Why: releasing after a hold emits a click over the just-opened menu.
    act(() => primary.click())
    expect(harness.onLaunchAgent).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('still launches when the press is released before the hold threshold', () => {
    vi.useFakeTimers()
    renderButton()
    const primary = getByRole(container, 'button', { name: 'Open Codex in a new tab' })

    dispatchPointer(primary, 'pointerdown')
    act(() => vi.advanceTimersByTime(NEW_TAB_HOLD_TO_OPEN_MENU_MS - 50))
    dispatchPointer(primary, 'pointerup')
    act(() => primary.click())

    expect(harness.onOpenMenu).not.toHaveBeenCalled()
    expect(harness.onLaunchAgent).toHaveBeenCalledExactlyOnceWith('codex')
    vi.useRealTimers()
  })

  it('does not let a hold released off the control swallow the next launch', () => {
    vi.useFakeTimers()
    renderButton()
    const primary = getByRole(container, 'button', { name: 'Open Codex in a new tab' })

    // Hold, then leave the control: no click ever reaches the button.
    dispatchPointer(primary, 'pointerdown')
    act(() => vi.advanceTimersByTime(NEW_TAB_HOLD_TO_OPEN_MENU_MS))
    dispatchPointer(primary, 'pointerleave')
    dispatchPointer(primary, 'pointerup')
    vi.useRealTimers()
    expect(harness.onLaunchAgent).not.toHaveBeenCalled()

    act(() => getByTestId(container, 'dismiss-menu').click())
    act(() => primary.click())

    expect(harness.onLaunchAgent).toHaveBeenCalledExactlyOnceWith('codex')
  })

  it('renders the chevron as the menu trigger so the menu stays reachable without holding', () => {
    renderButton()

    const trigger = getByTestId(container, 'dropdown-trigger')
    const chevron = getByRole(container, 'button', { name: 'More options' })
    expect(trigger.contains(chevron)).toBe(true)
  })

  it('disables the primary control while the default structured launch is pending', () => {
    harness.structuredLaunchStatus = 'pending'
    renderButton()

    const primary = getByRole(container, 'button', { name: 'Open Codex in a new tab' })
    expect(primary.hasAttribute('disabled')).toBe(true)

    act(() => primary.click())

    expect(harness.onLaunchAgent).not.toHaveBeenCalled()
  })

  it('falls back to the plain new-tab menu button when no default agent is usable', () => {
    harness.settings.defaultTuiAgent = 'blank'
    renderButton()
    expect(getByRole(container, 'button', { name: 'New tab' })).toBeTruthy()
    expect(queryByTestId(container, 'new-tab-menu-trigger')).toBeNull()
  })

  it('does not offer the agent quick launch when the surface owns its own agent button', () => {
    renderButton(false)

    expect(getByRole(container, 'button', { name: 'New tab' })).toBeTruthy()
    expect(queryByTestId(container, 'new-tab-menu-trigger')).toBeNull()
  })
})
