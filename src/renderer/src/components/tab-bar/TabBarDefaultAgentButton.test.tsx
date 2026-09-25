// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { getByRole } from '@testing-library/dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { TabBarDefaultAgentButton } from './TabBarDefaultAgentButton'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

type ButtonTestHarness = {
  settings: {
    defaultTuiAgent: TuiAgent | 'blank' | null
    disabledTuiAgents: TuiAgent[]
  }
  detectedIds: TuiAgent[]
  structuredLaunchStatus: 'idle' | 'pending'
  onLaunchAgent: ReturnType<typeof vi.fn<(agent: TuiAgent) => void>>
}

const harness = vi.hoisted((): ButtonTestHarness => ({
  settings: {
    defaultTuiAgent: 'codex',
    disabledTuiAgents: []
  },
  detectedIds: ['claude', 'codex'],
  structuredLaunchStatus: 'idle',
  onLaunchAgent: vi.fn<(agent: TuiAgent) => void>()
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

let container: HTMLDivElement
let root: Root

function renderButton(): void {
  act(() => {
    root.render(
      createElement(TabBarDefaultAgentButton, {
        worktreeId: 'worktree-1',
        onLaunchAgent: harness.onLaunchAgent
      })
    )
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
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('TabBarDefaultAgentButton', () => {
  it('delegates launch of the detected default agent to the tab-bar controller', () => {
    renderButton()

    act(() => getByRole(container, 'button', { name: 'Open Codex in a new tab' }).click())

    expect(harness.onLaunchAgent).toHaveBeenCalledExactlyOnceWith('codex')
  })

  it('hides the button when the default is blank, disabled, or not detected', () => {
    harness.settings.defaultTuiAgent = 'blank'
    renderButton()
    expect(container.querySelector('button')).toBeNull()

    harness.settings.defaultTuiAgent = 'codex'
    harness.settings.disabledTuiAgents = ['codex']
    renderButton()
    expect(container.querySelector('button')).toBeNull()

    harness.settings.disabledTuiAgents = []
    harness.detectedIds = ['claude']
    renderButton()
    expect(container.querySelector('button')).toBeNull()
  })

  it('disables the shortcut while the default structured launch is pending', () => {
    harness.structuredLaunchStatus = 'pending'
    renderButton()

    const button = getByRole(container, 'button', { name: 'Open Codex in a new tab' })
    expect(button.hasAttribute('disabled')).toBe(true)

    act(() => button.click())

    expect(harness.onLaunchAgent).not.toHaveBeenCalled()
  })
})
