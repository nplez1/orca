import { beforeEach, describe, expect, it, vi } from 'vitest'

const launchAgentInNewTab = vi.fn()
const shouldQueueTerminalFocusAfterMenuClose = vi.fn(() => false)
const toastError = vi.fn()

vi.mock('@/lib/launch-agent-in-new-tab', () => ({
  launchAgentInNewTab,
  shouldQueueTerminalFocusAfterMenuClose
}))
vi.mock('@/lib/agent-launch-request-id', () => ({ newAgentLaunchRequestId: () => 'req-1' }))
vi.mock('@/components/native-chat/use-native-chat-composer-reveal-focus', () => ({
  captureNativeChatComposerFocusIntent: () => ({ kind: 'none' })
}))
vi.mock('sonner', () => ({ toast: { error: toastError } }))

const { launchDefaultAgentInNewTab } = await import('./launch-default-agent-in-new-tab')

function context() {
  return {
    worktreeId: 'wt-1',
    groupId: 'group-1',
    onLocalTerminal: vi.fn(),
    onHostTerminal: vi.fn()
  }
}

beforeEach(() => {
  launchAgentInNewTab.mockReset()
  shouldQueueTerminalFocusAfterMenuClose.mockReset().mockReturnValue(false)
  toastError.mockReset()
})

// The split button is the pre-menu path: it has no rows of its own, so it must not depend on the
// menu model having settled, and it must leave the surface to the user's Chat UI setting.
describe('launchDefaultAgentInNewTab', () => {
  it('launches the agent without pinning a surface', () => {
    const ctx = context()
    launchAgentInNewTab.mockReturnValue({
      surface: { kind: 'local-terminal', tabId: 'tab-9' },
      requestId: 'req-1'
    })

    launchDefaultAgentInNewTab('claude', ctx)

    expect(launchAgentInNewTab).toHaveBeenCalledWith({
      requestId: 'req-1',
      focusIntent: { kind: 'none' },
      agent: 'claude',
      worktreeId: 'wt-1',
      groupId: 'group-1',
      launchSource: 'tab_bar_quick_launch'
    })
    // No `requestedSurface`: a chat row must not force a chat, and a chat-unavailable host must
    // still launch the agent's terminal.
    expect(launchAgentInNewTab.mock.calls[0][0]).not.toHaveProperty('requestedSurface')
    expect(ctx.onLocalTerminal).toHaveBeenCalledWith('tab-9')
  })

  it('queues host-terminal focus when the launch surface arrives asynchronously', () => {
    const ctx = context()
    launchAgentInNewTab.mockReturnValue({ surface: { kind: 'host' }, requestId: 'req-1' })
    shouldQueueTerminalFocusAfterMenuClose.mockReturnValue(true)

    launchDefaultAgentInNewTab('codex', ctx)

    expect(ctx.onHostTerminal).toHaveBeenCalledTimes(1)
    expect(ctx.onLocalTerminal).not.toHaveBeenCalled()
  })

  it('reports a build failure instead of launching nothing', () => {
    const ctx = context()
    launchAgentInNewTab.mockReturnValue(null)

    launchDefaultAgentInNewTab('pi', ctx)

    expect(toastError).toHaveBeenCalledTimes(1)
    expect(ctx.onLocalTerminal).not.toHaveBeenCalled()
    expect(ctx.onHostTerminal).not.toHaveBeenCalled()
  })
})
