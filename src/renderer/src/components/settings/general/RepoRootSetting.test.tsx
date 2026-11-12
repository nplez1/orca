// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../../shared/constants'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId
} from '../../../../../shared/execution-host'
import type { SettingsHostScope } from '../host-scope/settings-host-scope'
import { RepoRootSetting } from './RepoRootSetting'

const browseRuntimeServerDirectory = vi.hoisted(() => vi.fn())

vi.mock('@/runtime/files/reads/runtime-server-directory-browser', () => ({
  browseRuntimeServerDirectory
}))

const SERVER_ID = 'server-a'
const SERVER_HOST_ID = toRuntimeExecutionHostId(SERVER_ID)

const localScope: SettingsHostScope = {
  hostId: LOCAL_EXECUTION_HOST_ID,
  label: 'Local Mac',
  equivalentHostIds: [LOCAL_EXECUTION_HOST_ID],
  target: { kind: 'local' },
  available: true
}

const serverScope: SettingsHostScope = {
  hostId: SERVER_HOST_ID,
  label: 'Boston',
  equivalentHostIds: [SERVER_HOST_ID],
  target: { kind: 'environment', environmentId: SERVER_ID },
  available: true
}

function settingsWith(overrides: GlobalSettings['hostSettingOverrides']): GlobalSettings {
  return { ...getDefaultSettings('/Users/me'), hostSettingOverrides: overrides }
}

function renderRow(settings: GlobalSettings, scope: SettingsHostScope, updateSettings = vi.fn()) {
  render(<RepoRootSetting settings={settings} updateSettings={updateSettings} scope={scope} />)
  return { input: screen.getByRole<HTMLInputElement>('textbox'), updateSettings }
}

beforeEach(() => {
  browseRuntimeServerDirectory.mockReset()
  browseRuntimeServerDirectory.mockResolvedValue({ resolvedPath: '/home/me', entries: [] })
})

afterEach(cleanup)

describe('RepoRootSetting', () => {
  it('shows this computer’s convention when nothing is stored', async () => {
    renderRow(settingsWith({}), localScope)
    // The default workspace dir is <home>/orca/workspaces, so the clone parent is that tree itself.
    await waitFor(() =>
      expect(screen.getByRole<HTMLInputElement>('textbox').value).toBe('/Users/me/orca/workspaces')
    )
  })

  it('shows the flat-layout projects folder this computer’s clones and projects both use', async () => {
    renderRow({ ...settingsWith({}), worktreeLayoutMode: 'flat' }, localScope)
    await waitFor(() =>
      expect(screen.getByRole<HTMLInputElement>('textbox').value).toBe('/Users/me/orca/projects')
    )
  })

  it('prefers a stored root', async () => {
    const { input } = renderRow(
      settingsWith({ [LOCAL_EXECUTION_HOST_ID]: { defaultRepoRoot: '/data/checkouts' } }),
      localScope
    )
    expect(input.value).toBe('/data/checkouts')
  })

  it('reverts to the convention when the stored root is cleared', async () => {
    const user = userEvent.setup()
    const { updateSettings } = renderRow(
      settingsWith({ [LOCAL_EXECUTION_HOST_ID]: { defaultRepoRoot: '/data/checkouts' } }),
      localScope
    )
    await user.click(screen.getByRole('button', { name: /reset/i }))
    expect(updateSettings).toHaveBeenCalledWith({
      hostSettingOverrides: {}
    })
  })

  it('stores a value for this computer as a host override', async () => {
    const user = userEvent.setup()
    const { input, updateSettings } = renderRow(settingsWith({}), localScope)
    await waitFor(() => expect(input.value).toBe('/Users/me/orca/workspaces'))
    await user.clear(input)
    await user.type(input, '/data/checkouts{Enter}')
    expect(updateSettings).toHaveBeenCalledWith({
      hostSettingOverrides: {
        [LOCAL_EXECUTION_HOST_ID]: { defaultRepoRoot: '/data/checkouts' }
      }
    })
  })

  it('shows a remote machine’s stored root, not this computer’s', () => {
    const { input } = renderRow(
      settingsWith({ [SERVER_HOST_ID]: { defaultRepoRoot: '/srv/checkouts' } }),
      serverScope
    )
    expect(input.value).toBe('/srv/checkouts')
  })

  it('derives a remote convention from that host’s own home', async () => {
    renderRow(settingsWith({}), serverScope)
    await waitFor(() =>
      expect(screen.getByRole<HTMLInputElement>('textbox').value).toBe('/home/me/orca/workspaces')
    )
    expect(browseRuntimeServerDirectory).toHaveBeenCalledWith(SERVER_ID, '~')
  })

  it('refuses a relative root without saving it', async () => {
    const user = userEvent.setup()
    const { input, updateSettings } = renderRow(settingsWith({}), localScope)
    await waitFor(() => expect(input.value).toBe('/Users/me/orca/workspaces'))
    await user.clear(input)
    await user.type(input, 'src{Enter}')
    expect(updateSettings).not.toHaveBeenCalled()
    expect(input.value).toBe('src')
    expect(input.getAttribute('aria-invalid')).toBe('true')
  })

  it('refuses a relative root on a remote host too', async () => {
    const user = userEvent.setup()
    const { input, updateSettings } = renderRow(settingsWith({}), serverScope)
    await waitFor(() => expect(input.value).toBe('/home/me/orca/workspaces'))
    await user.clear(input)
    await user.type(input, 'orca/checkouts{Enter}')
    expect(updateSettings).not.toHaveBeenCalled()
    expect(input.getAttribute('aria-invalid')).toBe('true')
  })

  it('saves a home-prefixed root, which the host expands itself', async () => {
    const user = userEvent.setup()
    const { input, updateSettings } = renderRow(settingsWith({}), serverScope)
    await waitFor(() => expect(input.value).toBe('/home/me/orca/workspaces'))
    await user.clear(input)
    await user.type(input, '~/src{Enter}')
    expect(updateSettings).toHaveBeenCalledWith({
      hostSettingOverrides: { [SERVER_HOST_ID]: { defaultRepoRoot: '~/src' } }
    })
  })

  it('flags a relative root saved before this check existed', () => {
    const { input } = renderRow(
      settingsWith({ [SERVER_HOST_ID]: { defaultRepoRoot: 'src' } }),
      serverScope
    )
    expect(input.value).toBe('src')
    expect(input.getAttribute('aria-invalid')).toBe('true')
  })

  it('shows no error for this computer’s documented relative workspace dir', () => {
    const { input } = renderRow(
      { ...settingsWith({}), workspaceDir: '.orca/worktrees' },
      localScope
    )
    expect(input.value).toBe('')
    expect(input.getAttribute('aria-invalid')).toBeNull()
  })

  it('restores the saved folder when the override is reset after a refused draft', async () => {
    const user = userEvent.setup()
    // The override equals this computer’s convention, so clearing it leaves the shown value unchanged.
    const { input, updateSettings } = renderRow(
      settingsWith({ [LOCAL_EXECUTION_HOST_ID]: { defaultRepoRoot: '/Users/me/orca/workspaces' } }),
      localScope
    )
    await user.clear(input)
    await user.type(input, 'src{Enter}')
    expect(updateSettings).not.toHaveBeenCalled()
    expect(input.getAttribute('aria-invalid')).toBe('true')
    await user.click(screen.getByRole('button', { name: /reset/i }))
    expect(updateSettings).toHaveBeenCalledWith({ hostSettingOverrides: {} })
    expect(input.value).toBe('/Users/me/orca/workspaces')
    expect(input.getAttribute('aria-invalid')).toBeNull()
  })
})
