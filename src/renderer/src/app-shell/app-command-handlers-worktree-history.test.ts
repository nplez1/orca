import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppShortcutState, ShortcutDispatchInput } from './app-command-handlers'

const mocks = vi.hoisted(() => {
  const goBackWorktree = vi.fn()
  const goForwardWorktree = vi.fn()
  return {
    goBackWorktree,
    goForwardWorktree,
    // Why: these handlers reach the store only for the two history actions.
    store: { goBackWorktree, goForwardWorktree }
  }
})

vi.mock('../store', () => ({
  useAppStore: Object.assign(vi.fn(), { getState: () => mocks.store })
}))

vi.mock('@/lib/floating-workspace-terminal-actions', () => ({
  isFloatingWorkspacePanelFocused: () => false
}))

vi.mock('@/lib/terminal-shortcut-capture-notification', () => ({
  showTerminalShortcutCaptureNotification: vi.fn()
}))

import { createAppCommandHandlers } from './app-command-handlers'

function shortcutState(overrides: Partial<AppShortcutState> = {}): AppShortcutState {
  return {
    activeView: 'dashboard',
    activeWorktreeId: null,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the history handlers under test never read a shortcut action; the rest of the state is fully specified.
    actions: {} as AppShortcutState['actions'],
    creationLayoutActive: false,
    floatingTerminalEnabled: false,
    floatingTerminalOpen: false,
    floatingVisibleTabCount: 0,
    keybindings: {},
    openFloatingWorkspaceMaximized: vi.fn(),
    pluginCommands: [],
    setFloatingTerminalOpen: vi.fn(),
    terminalShortcutPolicy: 'orca-first',
    workspaceChromeActive: false,
    ...overrides
  }
}

function shortcutInput(): ShortcutDispatchInput {
  return {
    target: null,
    defaultPrevented: false,
    preventDefault: vi.fn()
  }
}

describe('workspace history app commands on the dashboard view', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // Why: the dashboard has no close control, so its way out is the same back/forward pair
  // every other history-recording page exposes.
  it('claims the back and forward chords with the dashboard in view', () => {
    const handlers = createAppCommandHandlers(shortcutState(), shortcutInput())

    expect(handlers.get('worktree.history.back')?.()).toBe(true)
    expect(mocks.goBackWorktree).toHaveBeenCalledOnce()
    expect(handlers.get('worktree.history.forward')?.()).toBe(true)
    expect(mocks.goForwardWorktree).toHaveBeenCalledOnce()
  })

  it('leaves the chord unclaimed on a view outside the history stack', () => {
    const handlers = createAppCommandHandlers(
      shortcutState({ activeView: 'settings' }),
      shortcutInput()
    )

    expect(handlers.get('worktree.history.back')?.()).toBe(false)
    expect(mocks.goBackWorktree).not.toHaveBeenCalled()
  })
})
