// @vitest-environment happy-dom

import React from 'react'
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { createEmptyRateLimitState } from '../../../../shared/rate-limit-state-factory'
import { useAppStore } from '../../store'
import { AccountsPane } from './AccountsPane'

const mocks = vi.hoisted(() => ({
  copilotGetStatus: vi.fn(),
  writeClipboardText: vi.fn(),
  refreshRateLimits: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn()
}))

// Why: the inline terminal owns a real PTY tab, which is out of scope here — these
// cases are about which command the pane hands it and what it does when it finishes.
vi.mock('../onboarding/OnboardingInlineCommandTerminal', () => ({
  OnboardingInlineCommandTerminal: (props: {
    command: string
    title: string
    onCommandFinished?: (exitCode: number | null) => void
    onTerminalExit?: () => void
  }) => (
    <div
      data-testid="inline-command-terminal"
      data-command={props.command}
      data-title={props.title}
    >
      <button type="button" onClick={() => props.onCommandFinished?.(0)}>
        finish-command
      </button>
      <button type="button" onClick={() => props.onTerminalExit?.()}>
        exit-terminal
      </button>
    </div>
  )
}))

vi.mock('sonner', () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError
  }
}))

// Why: the mount-time status read is the only way the pane learns the `gh` state, so
// these cases drive it through the bridge instead of a hand-built model.
const emptyAccountsState = {
  accounts: [],
  activeAccountId: null,
  activeAccountIdsByRuntime: { host: null, wsl: {} }
}

function installWindowApi(): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      claudeAccounts: { list: () => Promise.resolve(emptyAccountsState) },
      codexAccounts: { list: () => Promise.resolve(emptyAccountsState) },
      codexConfigSync: {
        status: () =>
          Promise.resolve({ state: 'synced', reason: null, systemConfigPath: '/tmp/config.toml' })
      },
      grokAccounts: {
        getStatus: () =>
          Promise.resolve({ signedIn: false, email: null, teamId: null, tokenFresh: false })
      },
      minimaxCredentials: {
        getStatus: () =>
          Promise.resolve({ configured: false, cookieConfigured: false, apiKeyConfigured: false })
      },
      copilotCredentials: { getStatus: mocks.copilotGetStatus },
      rateLimits: { refresh: mocks.refreshRateLimits },
      ui: { writeClipboardText: mocks.writeClipboardText, set: () => Promise.resolve() }
    }
  })
}

// Why: every credential section renders its own empty state, so the assertions have
// to stay inside the Copilot section rather than matching the whole pane.
function copilotSection(): ReturnType<typeof within> {
  const section = document.getElementById('accounts-copilot')
  if (!section) {
    throw new Error('GitHub Copilot section is not rendered')
  }
  return within(section)
}

function renderPane(): void {
  render(
    React.createElement(AccountsPane, {
      settings: getDefaultSettings('/tmp'),
      updateSettings: vi.fn()
    })
  )
}

function setWebClient(isWebClient: boolean): void {
  Object.defineProperty(globalThis, '__ORCA_WEB_CLIENT__', {
    configurable: true,
    value: isWebClient
  })
}

describe('AccountsPane GitHub Copilot setup', () => {
  beforeEach(() => {
    mocks.writeClipboardText.mockResolvedValue(undefined)
    mocks.refreshRateLimits.mockResolvedValue(createEmptyRateLimitState())
    installWindowApi()
    setWebClient(false)
    useAppStore.setState({ settingsSearchQuery: '', runtimeEnvironments: [] })
  })

  afterEach(() => {
    cleanup()
    setWebClient(false)
    vi.clearAllMocks()
  })

  it('presents a serving GitHub CLI sign-in as the Copilot source', async () => {
    mocks.copilotGetStatus.mockResolvedValue({
      configured: true,
      ghStatus: 'ok',
      ghSetupHint: null
    })

    renderPane()

    const copilot = copilotSection()
    expect(await copilot.findByText('Signed in with the GitHub CLI')).toBeTruthy()
    expect(
      copilot.getByText(
        'Orca reads Copilot usage with your GitHub CLI sign-in. Nothing is saved in Orca.'
      )
    ).toBeTruthy()
    // Nothing is left to do, so neither the run nor the copy affordance appears.
    expect(copilot.queryByRole('button', { name: 'Run setup command' })).toBeNull()
    expect(copilot.queryByRole('button', { name: 'Copy command' })).toBeNull()
    expect(copilot.queryByTestId('inline-command-terminal')).toBeNull()
    expect(copilot.getByRole('button', { name: 'Re-check' })).toBeTruthy()
  })

  it('shows guidance without a command when the GitHub CLI is not on PATH', async () => {
    mocks.copilotGetStatus.mockResolvedValue({
      configured: false,
      ghStatus: 'gh-missing',
      ghSetupHint: null
    })

    renderPane()

    const copilot = copilotSection()
    expect(await copilot.findByText('GitHub CLI not found')).toBeTruthy()
    expect(
      copilot.getByText('Copilot usage is read through the GitHub CLI. Install gh, then sign in.')
    ).toBeTruthy()
    expect(copilot.queryByRole('button', { name: 'Run setup command' })).toBeNull()
    expect(copilot.queryByRole('button', { name: 'Copy command' })).toBeNull()
    expect(copilot.getByRole('button', { name: 'Re-check' })).toBeTruthy()
  })

  it('carries the command main reports for an unusable sign-in', async () => {
    const hint = 'gh auth refresh -s user'
    mocks.copilotGetStatus.mockResolvedValue({
      configured: false,
      ghStatus: 'missing-scope',
      ghSetupHint: hint
    })

    renderPane()

    const copilot = copilotSection()
    expect(await copilot.findByText('GitHub CLI sign-in needs the user scope')).toBeTruthy()
    expect(
      copilot.getByText('Grant the missing scope and Orca will start tracking your Copilot usage.')
    ).toBeTruthy()
    expect(copilot.getByText(hint)).toBeTruthy()
    expect(copilot.getByRole('button', { name: 'Copy command' })).toBeTruthy()
    expect(copilot.getByRole('button', { name: 'Run setup command' })).toBeTruthy()
    // The terminal only appears once the user asks for it.
    expect(copilot.queryByTestId('inline-command-terminal')).toBeNull()
  })

  it('copies the command to the clipboard', async () => {
    const hint = 'gh auth login'
    mocks.copilotGetStatus.mockResolvedValue({
      configured: false,
      ghStatus: 'unauthenticated',
      ghSetupHint: hint
    })

    renderPane()

    const copilot = copilotSection()
    await copilot.findByText('Not signed in to GitHub')

    fireEvent.click(copilot.getByRole('button', { name: 'Copy command' }))

    await waitFor(() => expect(mocks.writeClipboardText).toHaveBeenCalledWith(hint))
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Copied command.')
  })

  it('opens the inline terminal on the reported command', async () => {
    const hint = 'gh auth refresh -s user'
    mocks.copilotGetStatus.mockResolvedValue({
      configured: false,
      ghStatus: 'missing-scope',
      ghSetupHint: hint
    })

    renderPane()

    const copilot = copilotSection()
    await copilot.findByText('GitHub CLI sign-in needs the user scope')

    fireEvent.click(copilot.getByRole('button', { name: 'Run setup command' }))

    const terminal = await copilot.findByTestId('inline-command-terminal')
    expect(terminal.dataset.command).toBe(hint)
    expect(terminal.dataset.title).toBe('GitHub CLI setup')
    // Why disabled: one terminal per command keeps a stale run from overlapping a new one.
    expect(copilot.getByRole('button', { name: 'Run setup command' })).toHaveProperty(
      'disabled',
      true
    )
    // The terminal goes away when its shell exits.
    fireEvent.click(within(terminal).getByRole('button', { name: 'exit-terminal' }))
    await waitFor(() => expect(copilot.queryByTestId('inline-command-terminal')).toBeNull())
  })

  it('re-reads the status and the usage when the setup command finishes', async () => {
    const hint = 'gh auth refresh -s user'
    mocks.copilotGetStatus
      .mockResolvedValueOnce({ configured: false, ghStatus: 'missing-scope', ghSetupHint: hint })
      .mockResolvedValue({ configured: true, ghStatus: 'ok', ghSetupHint: null })

    renderPane()

    const copilot = copilotSection()
    await copilot.findByText('GitHub CLI sign-in needs the user scope')

    fireEvent.click(copilot.getByRole('button', { name: 'Run setup command' }))
    const terminal = await copilot.findByTestId('inline-command-terminal')
    fireEvent.click(within(terminal).getByRole('button', { name: 'finish-command' }))

    expect(await copilot.findByText('Signed in with the GitHub CLI')).toBeTruthy()
    expect(mocks.copilotGetStatus).toHaveBeenCalledTimes(2)
    expect(mocks.refreshRateLimits).toHaveBeenCalled()
  })

  it('adopts the new status when Re-check is pressed', async () => {
    mocks.copilotGetStatus
      .mockResolvedValueOnce({
        configured: false,
        ghStatus: 'unauthenticated',
        ghSetupHint: 'gh auth login'
      })
      .mockResolvedValue({ configured: true, ghStatus: 'ok', ghSetupHint: null })

    renderPane()

    const copilot = copilotSection()
    await copilot.findByText('Not signed in to GitHub')

    fireEvent.click(copilot.getByRole('button', { name: 'Re-check' }))

    expect(await copilot.findByText('Signed in with the GitHub CLI')).toBeTruthy()
    expect(mocks.refreshRateLimits).toHaveBeenCalled()
  })

  it('keeps the command copyable but never opens a terminal in the web client', async () => {
    const hint = 'gh auth refresh -s user'
    mocks.copilotGetStatus.mockResolvedValue({
      configured: false,
      ghStatus: 'missing-scope',
      ghSetupHint: hint
    })
    setWebClient(true)

    renderPane()

    const copilot = copilotSection()
    expect(await copilot.findByText('GitHub CLI sign-in needs the user scope')).toBeTruthy()
    // Why: the web client's floating-terminal cwd resolves empty, so an inline terminal
    // there would never finish starting; the command is handed over instead.
    expect(copilot.queryByRole('button', { name: 'Run setup command' })).toBeNull()
    expect(copilot.queryByRole('button', { name: 'Re-check' })).toBeNull()
    expect(copilot.getByRole('button', { name: 'Copy command' })).toBeTruthy()
    expect(copilot.getByText(hint)).toBeTruthy()
    expect(
      copilot.getByText(
        'Set Copilot usage up from Orca on the computer where you use the GitHub CLI.'
      )
    ).toBeTruthy()
  })
})
