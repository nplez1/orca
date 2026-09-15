// @vitest-environment happy-dom

import React from 'react'
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { useAppStore } from '../../store'
import { AccountsPane } from './AccountsPane'

const mocks = vi.hoisted(() => ({
  copilotGetStatus: vi.fn(),
  copilotSave: vi.fn(),
  writeClipboardText: vi.fn()
}))

// Why: the mount-time status read is the only way the pane learns its credential
// source, so these cases drive it through the bridge instead of a hand-built model.
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
      deepseekCredentials: {
        getStatus: () => Promise.resolve({ configured: false, apiKeyConfigured: false })
      },
      fireworksCredentials: {
        getStatus: () =>
          Promise.resolve({ configured: false, apiKeyConfigured: false, accountIdOverride: null })
      },
      copilotCredentials: { getStatus: mocks.copilotGetStatus, save: mocks.copilotSave },
      ui: { writeClipboardText: mocks.writeClipboardText }
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

describe('AccountsPane GitHub Copilot credentials', () => {
  beforeEach(() => {
    mocks.writeClipboardText.mockResolvedValue(undefined)
    installWindowApi()
    useAppStore.setState({ settingsSearchQuery: '', runtimeEnvironments: [] })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('keeps the stored-token presentation when the token came from the store', async () => {
    mocks.copilotGetStatus.mockResolvedValue({
      configured: true,
      enterpriseSlug: 'acme',
      source: 'stored',
      ghSetupHint: null
    })

    renderPane()

    const copilot = copilotSection()
    expect(await copilot.findByText('Stored locally')).toBeTruthy()
    expect(copilot.queryByText('Credentials not set')).toBeNull()
    expect(copilot.queryByText('Using your GitHub CLI sign-in')).toBeNull()
    expect(copilot.getByDisplayValue('acme')).toBeTruthy()
    expect(copilot.getByRole('button', { name: 'Replace' })).toBeTruthy()
    expect(copilot.getByRole('button', { name: 'Forget token' })).toBeTruthy()
  })

  it('presents the GitHub CLI sign-in as a source rather than an unconfigured state', async () => {
    mocks.copilotGetStatus.mockResolvedValue({
      configured: true,
      enterpriseSlug: null,
      source: 'github-cli',
      ghSetupHint: null
    })

    renderPane()

    const copilot = copilotSection()
    expect(await copilot.findByText('Using your GitHub CLI sign-in')).toBeTruthy()
    // The token form is an override here, so nothing may claim the credential is
    // missing or that a stored token exists.
    expect(copilot.queryByText('Credentials not set')).toBeNull()
    expect(copilot.queryByText('Stored locally')).toBeNull()
    expect(copilot.queryByText('Saved')).toBeNull()
    expect(copilot.getByText('Optional override')).toBeTruthy()
    expect(copilot.getByPlaceholderText('your-enterprise').getAttribute('value')).toBe('')
    expect(copilot.getByRole('button', { name: 'Save' })).toBeTruthy()
    // Nothing is stored, so there is nothing to forget.
    expect(copilot.queryByRole('button', { name: 'Forget token' })).toBeNull()
    expect(copilot.queryByRole('button', { name: 'Copy command' })).toBeNull()
  })

  it('surfaces the GitHub CLI setup hint as a copyable command', async () => {
    const hint = 'gh auth refresh -s user'
    mocks.copilotGetStatus.mockResolvedValue({
      configured: false,
      enterpriseSlug: null,
      source: 'none',
      ghSetupHint: hint
    })

    renderPane()

    const copilot = copilotSection()
    expect(await copilot.findByText('Credentials not set')).toBeTruthy()
    expect(copilot.getByText(hint)).toBeTruthy()

    fireEvent.click(copilot.getByRole('button', { name: 'Copy command' }))

    await waitFor(() => expect(mocks.writeClipboardText).toHaveBeenCalledWith(hint))
    expect(await copilot.findByRole('button', { name: 'Copied' })).toBeTruthy()
  })

  it('offers no command when main reports no actionable GitHub CLI step', async () => {
    mocks.copilotGetStatus.mockResolvedValue({
      configured: false,
      enterpriseSlug: null,
      source: 'none',
      ghSetupHint: null
    })

    renderPane()

    const copilot = copilotSection()
    expect(await copilot.findByText('Credentials not set')).toBeTruthy()
    expect(copilot.queryByRole('button', { name: 'Copy command' })).toBeNull()
  })

  it('lets a pasted token override the GitHub CLI source', async () => {
    mocks.copilotGetStatus.mockResolvedValue({
      configured: true,
      enterpriseSlug: null,
      source: 'github-cli',
      ghSetupHint: null
    })
    mocks.copilotSave.mockResolvedValue({
      configured: true,
      enterpriseSlug: 'acme',
      source: 'stored',
      ghSetupHint: null
    })

    renderPane()

    const copilot = copilotSection()
    expect(await copilot.findByText('Using your GitHub CLI sign-in')).toBeTruthy()
    // The override only becomes saveable once a token is typed; main cannot keep a
    // stored token that does not exist.
    expect(copilot.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true)

    fireEvent.change(copilot.getByPlaceholderText('Paste your GitHub token'), {
      target: { value: 'ghp_token' }
    })
    fireEvent.change(copilot.getByPlaceholderText('your-enterprise'), {
      target: { value: 'acme' }
    })
    fireEvent.click(copilot.getByRole('button', { name: 'Save' }))

    expect(await copilot.findByText('Stored locally')).toBeTruthy()
    expect(mocks.copilotSave).toHaveBeenCalledWith('ghp_token', 'acme')
    expect(copilot.queryByText('Using your GitHub CLI sign-in')).toBeNull()
    expect(copilot.getByRole('button', { name: 'Replace' })).toBeTruthy()
    expect(copilot.getByRole('button', { name: 'Forget token' })).toBeTruthy()
  })
})
