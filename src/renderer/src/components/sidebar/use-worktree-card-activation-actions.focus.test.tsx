// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeCardProps } from './worktree-card-model'
import { repo, worktree as baseWorktree } from './worktree-list-groups-test-fixtures'

type PolicyState = {
  activeView: string
  activeTabType: string
  activeWorktreeId: string | null
  activeWorkspaceExecutionHostId: string | null
  activeTabId: string | null
  activeModal: string
  terminalLayoutsByTabId: Record<string, { activeLeafId: string | null } | undefined>
}

const state: PolicyState = {
  activeView: 'terminal',
  activeTabType: 'terminal',
  activeWorktreeId: 'wt-a',
  activeWorkspaceExecutionHostId: null,
  activeTabId: 'tab-a',
  activeModal: 'none',
  terminalLayoutsByTabId: {}
}
const activateWorktreeFromSidebar = vi.fn()
const focusRuntime = vi.fn()
const findRegisteredTerminalTab = vi.fn()

vi.mock('@/store', () => ({
  useAppStore: { getState: () => state, subscribe: () => () => {} }
}))
vi.mock('@/lib/sidebar-worktree-activation', () => ({ activateWorktreeFromSidebar }))
vi.mock('@/runtime/mounted-terminal-tab-registry', () => ({
  focusRuntimeTerminalSurface: focusRuntime,
  findRegisteredTerminalTab
}))

const { useWorktreeCardActivationActions } = await import('./use-worktree-card-activation-actions')
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const worktree: WorktreeCardProps['worktree'] = {
  ...baseWorktree,
  id: 'wt-b',
  displayName: 'wt-b'
}

let root: Root
let container: HTMLDivElement
let listbox: HTMLElement
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

function Card(): React.JSX.Element {
  const { handleClick } = useWorktreeCardActivationActions({
    worktree,
    repo,
    affiliateListMode: false,
    onSelectionGesture: undefined,
    isActive: false,
    activationRowKey: 'wt-b',
    onActivate: undefined,
    onWorktreeCardClick: undefined,
    onImmediateActivate: undefined,
    isDeleting: false,
    isSshDisconnected: false,
    updateWorktreeMeta: vi.fn(),
    setWorkspaceUnreadByUser: vi.fn(),
    openModal: vi.fn()
  })
  return (
    <div role="listbox" data-worktree-sidebar tabIndex={0}>
      <div role="option" data-worktree-id="wt-b" onClick={handleClick}>
        wt-b
      </div>
    </div>
  )
}

beforeEach(() => {
  frames = []
  state.activeWorktreeId = 'wt-a'
  state.activeTabId = 'tab-a'
  activateWorktreeFromSidebar.mockReset()
  focusRuntime.mockReset()
  findRegisteredTerminalTab.mockReturnValue({
    key: 'wt-b\0tab-b',
    tab: {
      tabId: 'tab-b',
      worktreeId: 'wt-b',
      getManager: () => ({ getActivePane: () => null, getPanes: () => [] })
    }
  })
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

describe('workspace card click focus', () => {
  function requireElement(selector: string): HTMLElement {
    const element = container.querySelector<HTMLElement>(selector)
    if (element === null) {
      throw new Error(`Missing ${selector}`)
    }
    return element
  }

  function mountCard(): HTMLElement {
    act(() => root.render(<Card />))
    listbox = requireElement('[role="listbox"]')
    return requireElement('[data-worktree-id="wt-b"]')
  }

  it('returns focus from the sidebar listbox to the activated agent tab', () => {
    const card = mountCard()
    activateWorktreeFromSidebar.mockImplementation(() => {
      state.activeWorktreeId = 'wt-b'
      state.activeTabId = 'tab-b'
      return { primaryTabId: 'tab-b' }
    })

    act(() => {
      // Chromium focuses the listbox container on mousedown inside it.
      listbox.focus()
      card.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    })
    expect(document.activeElement).toBe(listbox)

    flushFrames()

    expect(focusRuntime).toHaveBeenCalledWith('tab-b', null, 'wt-b')
    expect(document.activeElement).toBe(helper)
  })

  it('declines when activation produces no workspace to focus', () => {
    const card = mountCard()
    activateWorktreeFromSidebar.mockReturnValue(false)

    act(() => {
      listbox.focus()
      card.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    })
    flushFrames()

    expect(focusRuntime).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(listbox)
  })
})
