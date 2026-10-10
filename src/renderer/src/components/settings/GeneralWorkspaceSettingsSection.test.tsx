// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { GeneralWorkspaceSettingsSection } from './GeneralWorkspaceSettingsSection'
import type { ReactNode } from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'

vi.mock('./WorkspaceDirectorySetting', () => ({ WorkspaceDirectorySetting: () => null }))
vi.mock('./OpenInMenuSetting', () => ({ OpenInMenuSetting: () => null }))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function renderSection(
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>,
  options: {
    defaultsSupported?: boolean
    sourceDefaultsSupported?: boolean
    worktreeVisibilityDefaults?: ReturnType<typeof getDefaultSettings>['worktreeVisibilityDefaults']
  } = {}
): void {
  const settings = getDefaultSettings('/home/user')
  settings.worktreeVisibilityDefaults = options.worktreeVisibilityDefaults
  act(() => {
    root.render(
      <GeneralWorkspaceSettingsSection
        settings={settings}
        updateSettings={updateSettings}
        defaultsSupported={options.defaultsSupported}
        sourceDefaultsSupported={options.sourceDefaultsSupported}
      />
    )
  })
}

function getSegment(label: string, visibility: 'show' | 'hide' = 'show'): HTMLButtonElement {
  const control = container.querySelector<HTMLButtonElement>(
    `[aria-label="Visibility for ${label}"] [data-visibility="${visibility}"]`
  )
  if (!control) {
    throw new Error(`${visibility} segment not found: ${label}`)
  }
  return control
}

function getLayoutOption(label: string): HTMLButtonElement | null {
  const group = container.querySelector('[role="radiogroup"][aria-label="Workspace Layout"]')
  if (!group) {
    return null
  }
  const options = [...group.querySelectorAll('button')].filter(
    (button): button is HTMLButtonElement => button instanceof HTMLButtonElement
  )
  return options.find((button) => button.textContent === label) ?? null
}

describe('GeneralWorkspaceSettingsSection layout control', () => {
  it('starts on the project-folder option every install now defaults to', () => {
    renderSection(vi.fn())

    expect(getLayoutOption('One folder per project')?.getAttribute('aria-checked')).toBe('true')
    expect(getLayoutOption('Flat')?.getAttribute('aria-checked')).toBe('false')
  })

  it('writes the mode and the legacy boolean when the shape changes', async () => {
    const updateSettings = vi.fn()
    renderSection(updateSettings)

    await act(async () => {
      getLayoutOption('Flat')?.click()
    })

    // Why the boolean as well: an older reader of these settings only understands it, so leaving
    // it stale would let the same host place worktrees two different ways.
    expect(updateSettings).toHaveBeenCalledWith({
      worktreeLayoutMode: 'flat',
      nestWorkspaces: false
    })
  })

  it('writes a still-nesting mode as a true boolean', async () => {
    const updateSettings = vi.fn()
    renderSection(updateSettings)

    await act(async () => {
      getLayoutOption('Nest Workspaces')?.click()
    })

    expect(updateSettings).toHaveBeenCalledWith({
      worktreeLayoutMode: 'repo-nested',
      nestWorkspaces: true
    })
  })
})

describe('GeneralWorkspaceSettingsSection external visibility', () => {
  it('exposes a stable deep-link target for global defaults', () => {
    renderSection(vi.fn())

    expect(
      container.querySelector('[data-settings-section="general-global-worktree-visibility"]')
    ).not.toBeNull()
  })

  it('writes the global Other locations default without touching repositories', async () => {
    const updateSettings = vi.fn()
    renderSection(updateSettings)

    await act(async () => {
      getSegment('Other locations').click()
    })

    expect(updateSettings).toHaveBeenCalledWith({
      worktreeVisibilityDefaults: { external: 'show' }
    })
  })

  it('keeps Other locations available while source defaults require a newer host', () => {
    renderSection(vi.fn(), { defaultsSupported: true, sourceDefaultsSupported: false })

    expect(getSegment('Claude Code').disabled).toBe(true)
    expect(getSegment('GSD').disabled).toBe(true)
    expect(getSegment('Other locations').disabled).toBe(false)
    expect(container.querySelector<HTMLInputElement>('#custom-worktree-root')?.disabled).toBe(true)
    expect(container.textContent).toContain('Update this server to configure source defaults.')
  })

  it('disables all visibility defaults when the paired host lacks base support', () => {
    renderSection(vi.fn(), { defaultsSupported: false, sourceDefaultsSupported: false })

    expect(getSegment('Claude Code').disabled).toBe(true)
    expect(getSegment('GSD').disabled).toBe(true)
    expect(getSegment('Other locations').disabled).toBe(true)
    expect(container.querySelector<HTMLInputElement>('#custom-worktree-root')?.disabled).toBe(true)
    expect(container.textContent).toContain('Update this server to configure visibility defaults.')
  })

  it('writes only Other locations when a downgraded host retains source fields', async () => {
    const updateSettings = vi.fn()
    renderSection(updateSettings, {
      sourceDefaultsSupported: false,
      worktreeVisibilityDefaults: {
        external: 'hide',
        customSources: [{ id: 'team', rootPath: '/srv/team' }],
        sourcePreferences: { builtIn: { claude: 'show' } }
      }
    })

    await act(async () => {
      getSegment('Other locations').click()
    })

    expect(updateSettings).toHaveBeenCalledWith({
      worktreeVisibilityDefaults: { external: 'show' }
    })
  })

  it('adds a global location disabled by default', async () => {
    const updateSettings = vi.fn()
    renderSection(updateSettings)
    const input = container.querySelector<HTMLInputElement>('#custom-worktree-root')!
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    act(() => {
      setValue?.call(input, '/srv/team-worktrees')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[type="submit"]')?.click()
    })

    const defaults = updateSettings.mock.calls[0]?.[0].worktreeVisibilityDefaults
    expect(defaults).toMatchObject({
      external: 'hide',
      customSources: [{ rootPath: '/srv/team-worktrees' }],
      sourcePreferences: { custom: expect.any(Object) }
    })
    const sourceId = defaults.customSources[0].id
    expect(defaults.sourcePreferences.custom).toEqual({ [sourceId]: 'hide' })
  })
})
