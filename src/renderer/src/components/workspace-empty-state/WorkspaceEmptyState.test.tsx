// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const mocks = vi.hoisted(() => ({
  launchingDefaultAgent: vi.fn(),
  appState: { repos: [], keybindings: {} }
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof mocks.appState) => unknown) => selector(mocks.appState)
}))

vi.mock('@/components/tab-bar/use-tab-bar-default-agent', () => ({
  useTabBarDefaultAgent: () => mocks.launchingDefaultAgent()
}))

vi.mock('../../../../../resources/logo.svg', () => ({ default: 'logo.svg' }))

const { WorkspaceEmptyState } = await import('./WorkspaceEmptyState')

function renderEmptyState(overrides?: { onNewTerminal?: () => void; onNewAgent?: () => void }) {
  return render(
    <WorkspaceEmptyState
      worktreeId="repo1::/path/wt1"
      onNewTerminal={overrides?.onNewTerminal ?? (() => {})}
      onNewAgent={overrides?.onNewAgent ?? (() => {})}
    />
  )
}

beforeEach(() => {
  mocks.appState = { repos: [], keybindings: {} }
  mocks.launchingDefaultAgent.mockReturnValue({ agent: null, isAgentLaunchPending: false })
  Object.assign(window, {
    api: {
      gh: {
        checkOrcaStarred: vi.fn().mockResolvedValue(true),
        starOrca: vi.fn().mockResolvedValue(true)
      },
      starNag: { complete: vi.fn().mockResolvedValue(undefined) },
      shell: { openUrl: vi.fn().mockResolvedValue(undefined) }
    }
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('WorkspaceEmptyState', () => {
  it('offers a new terminal and reports the click', async () => {
    const onNewTerminal = vi.fn()
    renderEmptyState({ onNewTerminal })

    await userEvent.click(screen.getByRole('button', { name: 'New terminal' }))

    expect(onNewTerminal).toHaveBeenCalledTimes(1)
  })

  it('offers the default agent and launches it', async () => {
    mocks.launchingDefaultAgent.mockReturnValue({ agent: 'claude', isAgentLaunchPending: false })
    const onNewAgent = vi.fn()
    renderEmptyState({ onNewAgent })

    await userEvent.click(screen.getByRole('button', { name: /New Claude agent/ }))

    expect(onNewAgent).toHaveBeenCalledWith('claude')
  })

  // Why: a workspace whose host lists no launchable agent must not offer a button that can only
  // toast "no agent CLI detected"; the terminal action stays.
  it('hides the agent action when no default agent is launchable', () => {
    renderEmptyState()

    expect(screen.queryByRole('button', { name: /agent/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'New terminal' })).toBeInTheDocument()
  })

  it('names the shortcut that opens each kind of tab', () => {
    // Why Mac: `tab.newAgent` has no default binding on Windows or Linux, and an unbound action
    // deliberately draws no row.
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' })
    mocks.launchingDefaultAgent.mockReturnValue({ agent: 'claude', isAgentLaunchPending: false })
    renderEmptyState()

    expect(screen.getByText('New terminal tab')).toBeInTheDocument()
    expect(screen.getByText('New agent tab')).toBeInTheDocument()
  })

  it('draws no shortcut row for an action this platform leaves unbound', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' })
    mocks.launchingDefaultAgent.mockReturnValue({ agent: 'claude', isAgentLaunchPending: false })
    renderEmptyState()

    expect(screen.getByText('New terminal tab')).toBeInTheDocument()
    expect(screen.queryByText('New agent tab')).toBeNull()
  })
})
