// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const updateSettings = vi.fn()

vi.mock('@/store', () => ({
  useAppStore: (
    selector: (state: {
      settings: {
        experimentalAgentDashboardMode: 'in-window'
        experimentalAgentDashboardShowIdle: boolean
      }
      updateSettings: typeof updateSettings
    }) => unknown
  ) =>
    selector({
      settings: {
        experimentalAgentDashboardMode: 'in-window',
        experimentalAgentDashboardShowIdle: false
      },
      updateSettings
    })
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

import { AgentDashboardSettingsMenu } from './AgentDashboardSettingsMenu'

let root: Root | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  container = null
  updateSettings.mockReset()
})

describe('AgentDashboardSettingsMenu', () => {
  it('owns the idle-agent visibility setting', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root?.render(<AgentDashboardSettingsMenu onOpenChange={vi.fn()} />)
    })

    const toggle = container.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="Show idle agents"]'
    )
    expect(toggle).not.toBeNull()

    act(() => toggle?.click())

    expect(updateSettings).toHaveBeenCalledWith({ experimentalAgentDashboardShowIdle: true })
  })

  it('reports the mode handoff only when the mode actually changed', () => {
    const onModeChange = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root?.render(<AgentDashboardSettingsMenu onModeChange={onModeChange} />)
    })

    const options = container.querySelectorAll<HTMLButtonElement>('button[role="radio"]')
    expect(Array.from(options, (option) => option.textContent)).toEqual(['In-window', 'Pop-out'])

    act(() => options[0]?.click())
    expect(updateSettings).not.toHaveBeenCalled()
    expect(onModeChange).not.toHaveBeenCalled()

    act(() => options[1]?.click())
    expect(updateSettings).toHaveBeenCalledWith({ experimentalAgentDashboardMode: 'popout' })
    expect(onModeChange).toHaveBeenCalledWith('popout')
  })
})
