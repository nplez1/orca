// @vitest-environment happy-dom
import { act, useEffect, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActivityBarItem } from './activity-bar-buttons'

const sidebarState = {
  rightSidebarTab: 'checks',
  rightSidebarRouteRequestId: 0,
  setRightSidebarTab: vi.fn(),
  showRightSidebarFiles: vi.fn(),
  setRightSidebarEffectiveTab: vi.fn()
}
type AgentState = {
  activeView: string
  activeTabType: string
  activeWorktreeId: string | null
  activeWorkspaceExecutionHostId: string | null
  activeTabId: string | null
  activeModal: string
  terminalLayoutsByTabId: Record<string, { activeLeafId: string | null } | undefined>
}

const agentState: AgentState = {
  activeView: 'terminal',
  activeTabType: 'terminal',
  activeWorktreeId: 'wt-1',
  activeWorkspaceExecutionHostId: null,
  activeTabId: 'tab-1',
  activeModal: 'none',
  terminalLayoutsByTabId: {}
}
const focusRuntime = vi.fn()

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof sidebarState) => unknown) => selector(sidebarState),
    {
      getState: () => agentState,
      subscribe: () => () => {}
    }
  )
}))
vi.mock('@/runtime/mounted-terminal-tab-registry', () => ({
  focusRuntimeTerminalSurface: focusRuntime,
  findRegisteredTerminalTab: () => ({
    key: 'wt-1\0tab-1',
    tab: {
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      getManager: () => ({ getActivePane: () => null, getPanes: () => [] })
    }
  })
}))

const { useRightSidebarTabRouting } = await import('./use-right-sidebar-tab-routing')
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const ITEM_ICON = (): null => null
const visibleItems: ActivityBarItem[] = [
  { id: 'checks', icon: ITEM_ICON, title: 'Checks', shortcut: '' },
  { id: 'vault', icon: ITEM_ICON, title: 'AiVault', shortcut: '' }
]

let root: Root
let container: HTMLDivElement
let helper: HTMLTextAreaElement
let frames: FrameRequestCallback[]

function flushFrames(): void {
  const pending = frames
  frames = []
  act(() => {
    for (const frame of pending) {
      frame(0)
    }
  })
}

/** Stands in for a panel that asks for the search field explicitly (AiVault's one-shot). */
function RequestedSearchField(): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => inputRef.current?.focus(), [])
  return <input aria-label="Search sessions" ref={inputRef} />
}

function PanelTabs(): React.JSX.Element {
  const [tab, setTab] = useState<'checks' | 'vault'>('checks')
  const [request] = useState(1)
  const { selectActivityTab } = useRightSidebarTabRouting({
    visibleItems,
    activeFolderWorkspaceKey: null,
    pluginSystemEnabled: false,
    pluginFetchStatus: 'idle',
    installedPluginTabKeys: new Set<string>()
  })
  return (
    <div>
      <button
        onClick={(event) => {
          selectActivityTab('checks', event.detail > 0)
          setTab('checks')
        }}
      >
        Checks
      </button>
      <button
        onClick={(event) => {
          selectActivityTab('vault', event.detail > 0)
          setTab('vault')
        }}
      >
        AiVault
      </button>
      {tab === 'vault' && request > 0 ? <RequestedSearchField /> : null}
    </div>
  )
}

/** `detail` is 1 for a pointer click and 0 for the click Enter/Space synthesises. */
function clickButton(label: string, detail = 1): void {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent === label
  )
  if (!button) {
    throw new Error(`Missing ${label} button`)
  }
  act(() => {
    button.focus()
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail }))
  })
}

beforeEach(() => {
  frames = []
  focusRuntime.mockReset()
  focusRuntime.mockImplementation(() => {
    helper.focus()
    return true
  })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})

  container = document.createElement('div')
  helper = document.createElement('textarea')
  helper.className = 'xterm-helper-textarea'
  document.body.append(container, helper)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

describe('right sidebar panel tab focus', () => {
  it('returns focus from the tab strip to the agent tab', () => {
    act(() => root.render(<PanelTabs />))

    clickButton('Checks')
    expect(document.activeElement).toBe(container.querySelector('button'))

    flushFrames()

    expect(focusRuntime).toHaveBeenCalledWith('tab-1', null, 'wt-1')
    expect(document.activeElement).toBe(helper)
  })

  it('leaves a keyboard-activated tab its focus', () => {
    act(() => root.render(<PanelTabs />))

    clickButton('Checks', 0)
    flushFrames()

    expect(focusRuntime).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(container.querySelector('button'))
  })

  it('leaves focus in a search field the panel asked for', () => {
    act(() => root.render(<PanelTabs />))

    clickButton('AiVault')
    flushFrames()

    expect(focusRuntime).not.toHaveBeenCalled()
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Search sessions')
  })
})
