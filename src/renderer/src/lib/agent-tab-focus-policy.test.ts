// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type PolicyState = {
  activeView: string
  activeTabType: string
  activeWorktreeId: string | null
  activeTabId: string | null
  terminalLayoutsByTabId: Record<string, { activeLeafId: string | null } | undefined>
}

const mocks = vi.hoisted(() => {
  const state: PolicyState = {
    activeView: 'terminal',
    activeTabType: 'terminal',
    activeWorktreeId: 'wt-1',
    activeTabId: 'tab-1',
    terminalLayoutsByTabId: {}
  }
  return {
    state,
    findRegisteredTerminalTab: vi.fn(),
    focusRuntimeTerminalSurface: vi.fn(),
    paneIsCoveredByNativeChat: vi.fn(),
    requestNativeChatComposerFocus: vi.fn(),
    refreshTerminalImeInputContext: vi.fn()
  }
})

vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('@/runtime/mounted-terminal-tab-registry', () => ({
  findRegisteredTerminalTab: mocks.findRegisteredTerminalTab,
  focusRuntimeTerminalSurface: mocks.focusRuntimeTerminalSurface
}))
vi.mock('@/components/terminal-pane/native-chat-covered-pane', () => ({
  paneIsCoveredByNativeChat: mocks.paneIsCoveredByNativeChat,
  focusNativeChatCover: vi.fn(() => false)
}))
vi.mock('@/components/native-chat/use-native-chat-composer-reveal-focus', () => ({
  requestNativeChatComposerFocus: mocks.requestNativeChatComposerFocus
}))
vi.mock('@/components/terminal-pane/terminal-ime-input-context-refresh', () => ({
  refreshTerminalImeInputContext: mocks.refreshTerminalImeInputContext
}))

import {
  focusAgentTabSurface,
  isAgentTabFocusClaimed,
  restoreAgentTabFocusAfterBackgroundClick,
  restoreAgentTabFocusAfterChromeClick,
  restoreAgentTabFocusAfterGesture,
  restoreAgentTabFocusAfterPanelBackgroundClick
} from './agent-tab-focus-policy'

type FakePane = { container: HTMLElement }

let pendingFrames: FrameRequestCallback[] = []
let tabContainer: HTMLDivElement
let xterm: HTMLDivElement
let helper: HTMLTextAreaElement
let chatCover: HTMLDivElement
let composer: HTMLInputElement
let plainPane: FakePane
let chatPane: FakePane
let activePane: FakePane | null
let composerReachable: boolean
let coveredPanes: Set<FakePane>

function flushFrames(): void {
  const frames = pendingFrames
  pendingFrames = []
  for (const frame of frames) {
    frame(0)
  }
}

/** What a pointer click on chrome does: decide one frame after the gesture commits. */
function restoreAfterGesture(clickDetail = 1): void {
  restoreAgentTabFocusAfterGesture(clickDetail)
  flushFrames()
}

/**
 * Model the mounted-tab registry: a leaf request realigns the manager to that
 * leaf's pane, and the no-leaf request focuses the manager's active pane — but
 * only when nothing covers it.
 */
function modelTerminalSurface(): void {
  const panes: Record<string, FakePane | undefined> = {
    'leaf-left': plainPane,
    'leaf-chat': chatPane
  }
  mocks.focusRuntimeTerminalSurface.mockImplementation((_tabId: string, leafId: string | null) => {
    if (leafId !== null) {
      const pane = panes[leafId]
      if (!pane) {
        return false
      }
      activePane = pane
      if (coveredPanes.has(pane)) {
        return true
      }
      helper.focus()
      return true
    }
    if (activePane !== null && coveredPanes.has(activePane)) {
      return true
    }
    helper.focus()
    return true
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  pendingFrames = []
  coveredPanes = new Set()
  composerReachable = true
  mocks.state = {
    activeView: 'terminal',
    activeTabType: 'terminal',
    activeWorktreeId: 'wt-1',
    activeTabId: 'tab-1',
    terminalLayoutsByTabId: {}
  }

  tabContainer = document.createElement('div')
  xterm = document.createElement('div')
  xterm.className = 'xterm'
  helper = document.createElement('textarea')
  helper.className = 'xterm-helper-textarea'
  xterm.append(helper)
  chatCover = document.createElement('div')
  chatCover.className = 'native-chat-pane-shell'
  composer = document.createElement('input')
  chatCover.append(composer)
  tabContainer.append(xterm, chatCover)
  document.body.append(tabContainer)

  plainPane = { container: xterm }
  chatPane = { container: chatCover }
  activePane = plainPane
  modelTerminalSurface()
  mocks.paneIsCoveredByNativeChat.mockImplementation(
    (pane: FakePane | null) => pane !== null && coveredPanes.has(pane)
  )
  // Why: the real request only asks the reveal effect, which focuses a frame later.
  mocks.requestNativeChatComposerFocus.mockImplementation(() => {
    if (composerReachable) {
      pendingFrames.push(() => composer.focus())
    }
  })
  mocks.findRegisteredTerminalTab.mockReturnValue({
    key: 'wt-1\0tab-1',
    tab: {
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      getManager: () => ({
        getActivePane: () => activePane,
        getPanes: () => [plainPane, chatPane]
      }),
      getContainer: () => tabContainer
    }
  })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    pendingFrames.push(callback)
    return pendingFrames.length
  })
})

afterEach(() => {
  window.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

describe('restore focus after chrome', () => {
  it('returns focus to the displayed agent tab after a chrome click', () => {
    restoreAfterGesture()

    expect(document.activeElement).toBe(helper)
  })

  it('refreshes the IME input context of the terminal it refocused', () => {
    restoreAfterGesture()

    expect(mocks.refreshTerminalImeInputContext).toHaveBeenCalledWith(helper, {})
  })

  it.each([
    ['settings', { activeView: 'settings' }],
    ['tasks', { activeView: 'tasks' }],
    ['activity', { activeView: 'activity' }],
    ['mobile', { activeView: 'mobile' }],
    ['an editor tab', { activeTabType: 'editor' }],
    ['no active workspace', { activeWorktreeId: null }]
  ] as const)('leaves focus alone while %s is displayed', (_label, change) => {
    Object.assign(mocks.state, change)

    restoreAfterGesture()
    expect(mocks.focusRuntimeTerminalSurface).not.toHaveBeenCalled()
  })

  it('leaves a focused editable alone', () => {
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()

    restoreAfterGesture()
    expect(mocks.focusRuntimeTerminalSurface).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(input)
  })

  it('leaves focus inside a live overlay', () => {
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.append(dialog)

    expect(isAgentTabFocusClaimed()).toBe(true)
    restoreAfterGesture()
    expect(mocks.focusRuntimeTerminalSurface).not.toHaveBeenCalled()
  })

  it('leaves a keyboard-navigated sidebar owning focus', () => {
    const sidebar = document.createElement('div')
    sidebar.setAttribute('role', 'listbox')
    sidebar.setAttribute('data-worktree-sidebar', '')
    sidebar.setAttribute('data-keyboard-navigation', '')
    sidebar.tabIndex = 0
    document.body.append(sidebar)
    sidebar.focus()

    restoreAfterGesture()
    expect(document.activeElement).toBe(sidebar)
  })

  it('leaves focus in the terminal of another agent context', () => {
    const otherHelper = document.createElement('textarea')
    otherHelper.className = 'xterm-helper-textarea'
    const otherXterm = document.createElement('div')
    otherXterm.className = 'xterm'
    otherXterm.append(otherHelper)
    document.body.append(otherXterm)
    otherHelper.focus()

    restoreAfterGesture()
    expect(mocks.focusRuntimeTerminalSurface).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(otherHelper)
  })

  it('honours an explicit data-keep-keyboard-focus opt-out', () => {
    const panel = document.createElement('div')
    panel.setAttribute('data-keep-keyboard-focus', '')
    const titlebarButton = document.createElement('div')
    titlebarButton.tabIndex = 0
    panel.append(titlebarButton)
    document.body.append(panel)
    titlebarButton.focus()

    restoreAfterGesture()
    expect(document.activeElement).toBe(titlebarButton)
  })

  it('does not honour an opt-out that is no longer on screen', () => {
    const panel = document.createElement('div')
    panel.setAttribute('data-keep-keyboard-focus', '')
    panel.setAttribute('aria-hidden', 'true')
    const titlebarButton = document.createElement('div')
    titlebarButton.tabIndex = 0
    panel.append(titlebarButton)
    document.body.append(panel)
    titlebarButton.focus()

    restoreAfterGesture()
    expect(document.activeElement).toBe(helper)
  })

  it('keeps a chrome text selection instead of taking focus for the agent', () => {
    const label = document.createElement('span')
    label.textContent = 'feature/some-branch'
    document.body.append(label)
    const range = document.createRange()
    range.selectNodeContents(label)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)

    restoreAfterGesture()
    expect(mocks.focusRuntimeTerminalSurface).not.toHaveBeenCalled()
  })

  it('declines while the agent tab has no mounted terminal', () => {
    mocks.findRegisteredTerminalTab.mockReturnValue(null)

    restoreAfterGesture()
    expect(mocks.focusRuntimeTerminalSurface).not.toHaveBeenCalled()
    expect(mocks.refreshTerminalImeInputContext).not.toHaveBeenCalled()
  })
})

describe('focusAgentTabSurface', () => {
  it('restores the active leaf of a split tab', () => {
    expect(focusAgentTabSurface({ worktreeId: 'wt-1', tabId: 'tab-1', leafId: 'leaf-left' })).toBe(
      true
    )
    expect(mocks.focusRuntimeTerminalSurface).toHaveBeenCalledWith('tab-1', 'leaf-left', 'wt-1')
    expect(document.activeElement).toBe(helper)
  })

  it('falls back to the manager active pane when the stored leaf is gone', () => {
    expect(focusAgentTabSurface({ worktreeId: 'wt-1', tabId: 'tab-1', leafId: 'leaf-stale' })).toBe(
      true
    )
    expect(mocks.focusRuntimeTerminalSurface).toHaveBeenLastCalledWith('tab-1', null, 'wt-1')
    expect(document.activeElement).toBe(helper)
  })

  it('does not count a leaf request whose focus an overlay swallowed', () => {
    // Why: setActivePane reports success after asking, so a wake behind a closing
    // palette used to cancel the retry loop with the caret still on chrome. The null
    // path mirrors the registry and declines when focus did not land.
    mocks.focusRuntimeTerminalSurface.mockImplementation(
      (_tabId: string, leafId: string | null) => leafId !== null
    )

    expect(focusAgentTabSurface({ worktreeId: 'wt-1', tabId: 'tab-1', leafId: 'leaf-left' })).toBe(
      false
    )
    expect(document.activeElement).not.toBe(helper)
  })

  it('asks the chat composer to take focus when a chat covers the active pane', () => {
    coveredPanes.add(plainPane)

    // The reveal effect focuses a frame later, so the caller keeps waiting until then.
    expect(focusAgentTabSurface({ worktreeId: 'wt-1', tabId: 'tab-1', leafId: null })).toBe(false)
    expect(mocks.requestNativeChatComposerFocus).toHaveBeenCalledWith('tab-1')

    flushFrames()
    expect(document.activeElement).toBe(composer)
  })

  it('keeps waiting while the chat composer has not mounted yet', () => {
    coveredPanes.add(plainPane)
    composerReachable = false

    expect(focusAgentTabSurface({ worktreeId: 'wt-1', tabId: 'tab-1', leafId: null })).toBe(false)
  })

  it('restores a plain split leaf even when the active pane holds a chat', () => {
    // Why: the leaf is what the user was looking at, so chat-versus-terminal is
    // decided on the aimed pane rather than on the manager's stale active pane.
    coveredPanes.add(chatPane)

    expect(focusAgentTabSurface({ worktreeId: 'wt-1', tabId: 'tab-1', leafId: 'leaf-left' })).toBe(
      true
    )
    expect(mocks.requestNativeChatComposerFocus).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(helper)
  })

  it('asks the chat composer of a covered split leaf to take focus', () => {
    coveredPanes.add(chatPane)

    expect(focusAgentTabSurface({ worktreeId: 'wt-1', tabId: 'tab-1', leafId: 'leaf-chat' })).toBe(
      false
    )
    expect(mocks.requestNativeChatComposerFocus).toHaveBeenCalledWith('tab-1')

    flushFrames()
    expect(document.activeElement).toBe(composer)
  })
})

function clickChrome(
  handler: (event: {
    currentTarget: EventTarget | null
    target: EventTarget | null
    detail: number
  }) => void,
  event: { currentTarget: EventTarget | null; target: EventTarget | null; detail: number }
): void {
  handler(event)
  flushFrames()
}

describe('React chrome handlers', () => {
  it('restores focus after a pointer click on sidebar chrome', () => {
    const chrome = document.createElement('div')
    const header = document.createElement('span')
    chrome.append(header)
    document.body.append(chrome)

    clickChrome(restoreAgentTabFocusAfterChromeClick, {
      currentTarget: chrome,
      target: header,
      detail: 1
    })

    expect(document.activeElement).toBe(helper)
  })

  it('leaves a workspace card click to the deferral path', () => {
    const chrome = document.createElement('div')
    const card = document.createElement('div')
    card.setAttribute('role', 'option')
    card.setAttribute('data-worktree-id', 'wt-b')
    chrome.append(card)
    document.body.append(chrome)

    clickChrome(restoreAgentTabFocusAfterChromeClick, {
      currentTarget: chrome,
      target: card,
      detail: 1
    })

    expect(mocks.focusRuntimeTerminalSurface).not.toHaveBeenCalled()
  })

  it('restores after a click on a control inside a card', () => {
    const chrome = document.createElement('div')
    const card = document.createElement('div')
    card.setAttribute('role', 'option')
    card.setAttribute('data-worktree-id', 'wt-b')
    const toggle = document.createElement('button')
    card.append(toggle)
    chrome.append(card)
    document.body.append(chrome)

    // Why: only a plain click on the card is its activation — its own controls are
    // ordinary chrome, so they hand the caret back like anything else.
    clickChrome(restoreAgentTabFocusAfterChromeClick, {
      currentTarget: chrome,
      target: toggle,
      detail: 1
    })

    expect(document.activeElement).toBe(helper)
  })

  it('ignores a click inside a menu the sidebar portals out', () => {
    const chrome = document.createElement('div')
    const portaledItem = document.createElement('div')
    document.body.append(chrome, portaledItem)

    // React bubbles a portaled child's click to the sidebar root, but the target is
    // not a descendant of the sidebar in the DOM.
    clickChrome(restoreAgentTabFocusAfterChromeClick, {
      currentTarget: chrome,
      target: portaledItem,
      detail: 1
    })

    expect(mocks.focusRuntimeTerminalSurface).not.toHaveBeenCalled()
  })

  it('ignores a click inside a menu the panel portals out', () => {
    const panel = document.createElement('div')
    const portaledItem = document.createElement('div')
    document.body.append(panel, portaledItem)

    clickChrome(restoreAgentTabFocusAfterPanelBackgroundClick, {
      currentTarget: panel,
      target: portaledItem,
      detail: 1
    })

    expect(mocks.focusRuntimeTerminalSurface).not.toHaveBeenCalled()
  })

  it('restores after a pointer click on a panel background', () => {
    const panel = document.createElement('div')
    document.body.append(panel)

    clickChrome(restoreAgentTabFocusAfterPanelBackgroundClick, {
      currentTarget: panel,
      target: panel,
      detail: 1
    })

    expect(document.activeElement).toBe(helper)
  })

  it('leaves a keyboard-activated chrome click alone', () => {
    const chrome = document.createElement('div')
    const header = document.createElement('span')
    chrome.append(header)
    document.body.append(chrome)

    clickChrome(restoreAgentTabFocusAfterChromeClick, {
      currentTarget: chrome,
      target: header,
      detail: 0
    })

    expect(mocks.focusRuntimeTerminalSurface).not.toHaveBeenCalled()
  })
})

describe('deferred chrome gestures', () => {
  it('decides after the gesture commits, so a dialog it opened claims focus', () => {
    restoreAgentTabFocusAfterGesture(1)

    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.append(dialog)
    flushFrames()

    expect(mocks.focusRuntimeTerminalSurface).not.toHaveBeenCalled()
  })

  it('restores focus one frame after a pointer click on chrome', () => {
    restoreAgentTabFocusAfterGesture(1)
    flushFrames()

    expect(document.activeElement).toBe(helper)
  })

  it('leaves a keyboard-activated control its focus', () => {
    // Why: Enter or Space synthesises a detail-0 click; a keyboard user must keep
    // the place they navigated to.
    restoreAgentTabFocusAfterGesture(0)
    flushFrames()

    expect(mocks.focusRuntimeTerminalSurface).not.toHaveBeenCalled()
  })

  it('restores after a background click that dropped focus to the page', () => {
    helper.focus()
    helper.blur()
    expect(document.activeElement).toBe(document.body)

    restoreAgentTabFocusAfterBackgroundClick(1)
    flushFrames()

    expect(document.activeElement).toBe(helper)
  })

  it('keeps the focus a clicked row took for its own keyboard navigation', () => {
    const row = document.createElement('button')
    document.body.append(row)
    row.focus()

    restoreAgentTabFocusAfterBackgroundClick(1)
    flushFrames()

    expect(mocks.focusRuntimeTerminalSurface).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(row)
  })
})
