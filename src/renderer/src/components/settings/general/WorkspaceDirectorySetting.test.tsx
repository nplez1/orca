// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../../shared/constants'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  toSshExecutionHostId
} from '../../../../../shared/execution-host'
import type { SettingsHostScope } from '../host-scope/settings-host-scope'
import { WorkspaceDirectorySetting } from './WorkspaceDirectorySetting'

vi.mock('@/components/sidebar/host-path-browser/RemoteFileBrowser', () => ({
  RemoteFileBrowser: ({
    targetId,
    runtimeEnvironmentId,
    initialPath
  }: {
    targetId?: string
    runtimeEnvironmentId?: string
    initialPath?: string
  }) => (
    <div
      data-testid="remote-file-browser"
      data-target={targetId ?? ''}
      data-environment={runtimeEnvironmentId ?? ''}
      data-initial={initialPath ?? ''}
    />
  )
}))

const pickFolder = vi.fn<() => Promise<string | null>>()

const SERVER_ID = 'server-a'
const SERVER_HOST_ID = toRuntimeExecutionHostId(SERVER_ID)
const SSH_HOST_ID = toSshExecutionHostId('builder')

const serverScope: SettingsHostScope = {
  hostId: SERVER_HOST_ID,
  label: 'Boston',
  equivalentHostIds: [SERVER_HOST_ID],
  target: { kind: 'environment', environmentId: SERVER_ID },
  available: true
}

const localScope: SettingsHostScope = {
  hostId: LOCAL_EXECUTION_HOST_ID,
  label: 'Local Mac',
  equivalentHostIds: [LOCAL_EXECUTION_HOST_ID],
  target: { kind: 'local' },
  available: true
}

const machineOnlyScope: SettingsHostScope = {
  hostId: SSH_HOST_ID,
  label: 'builder.example.com',
  equivalentHostIds: [SSH_HOST_ID],
  target: null,
  available: true
}

function settingsWith(overrides: GlobalSettings['hostSettingOverrides']): GlobalSettings {
  return {
    ...getDefaultSettings('/Users/me'),
    workspaceDir: '/Users/me/orca/workspaces',
    hostSettingOverrides: overrides
  }
}

function renderRow(
  settings: GlobalSettings,
  scope: SettingsHostScope,
  updateSettings = vi.fn()
): { input: HTMLInputElement; updateSettings: ReturnType<typeof vi.fn> } {
  render(
    <WorkspaceDirectorySetting settings={settings} updateSettings={updateSettings} scope={scope} />
  )
  return { input: screen.getByRole<HTMLInputElement>('textbox'), updateSettings }
}

beforeEach(() => {
  pickFolder.mockReset()
  pickFolder.mockResolvedValue(null)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { repos: { pickFolder } }
  })
})

afterEach(cleanup)

describe('WorkspaceDirectorySetting', () => {
  it('shows the stored folder for the selected host', () => {
    const { input } = renderRow(
      settingsWith({ [SERVER_HOST_ID]: { defaultWorktreeLocation: '/srv/orca' } }),
      serverScope
    )
    expect(input.value).toBe('/srv/orca')
  })

  it('never shows this computer’s folder for another machine', () => {
    const { input } = renderRow(settingsWith({}), serverScope)
    expect(input.value).toBe('')
  })

  it('shows the client default for this computer', () => {
    const { input } = renderRow(settingsWith({}), localScope)
    expect(input.value).toBe('/Users/me/orca/workspaces')
  })

  it('writes only the selected host', async () => {
    const user = userEvent.setup()
    const { input, updateSettings } = renderRow(settingsWith({}), serverScope)
    await user.clear(input)
    await user.type(input, '/srv/orca{Enter}')
    expect(updateSettings).toHaveBeenCalledTimes(1)
    expect(updateSettings.mock.calls[0][0]).toEqual({
      hostSettingOverrides: { [SERVER_HOST_ID]: { defaultWorktreeLocation: '/srv/orca' } }
    })
  })

  it('re-reads the value when the scope changes instead of keeping the old draft', async () => {
    const user = userEvent.setup()
    const settings = settingsWith({ [SERVER_HOST_ID]: { defaultWorktreeLocation: '/srv/orca' } })
    const updateSettings = vi.fn()
    const { input, rerender } = (() => {
      const view = render(
        <WorkspaceDirectorySetting
          settings={settings}
          updateSettings={updateSettings}
          scope={serverScope}
        />
      )
      return { input: screen.getByRole<HTMLInputElement>('textbox'), rerender: view.rerender }
    })()
    await user.type(input, '-draft')
    rerender(
      <WorkspaceDirectorySetting
        settings={settingsWith({})}
        updateSettings={updateSettings}
        scope={localScope}
      />
    )
    await waitFor(() =>
      expect(screen.getByRole<HTMLInputElement>('textbox').value).toBe('/Users/me/orca/workspaces')
    )
  })

  it('clears only the selected host on reset', async () => {
    const user = userEvent.setup()
    const settings = settingsWith({
      [SERVER_HOST_ID]: { defaultWorktreeLocation: '/srv/orca' },
      [LOCAL_EXECUTION_HOST_ID]: { displayLabel: 'Work Mac' }
    })
    const { updateSettings } = renderRow(settings, serverScope)
    await user.click(screen.getByRole('button', { name: /reset/i }))
    expect(updateSettings.mock.calls[0][0]).toEqual({
      hostSettingOverrides: { [LOCAL_EXECUTION_HOST_ID]: { displayLabel: 'Work Mac' } }
    })
  })

  it('reads an override stored under the other id of a merged machine', () => {
    const mergedScope: SettingsHostScope = {
      hostId: SERVER_HOST_ID,
      label: 'builder.example.com',
      equivalentHostIds: [SERVER_HOST_ID, SSH_HOST_ID],
      target: { kind: 'environment', environmentId: SERVER_ID },
      available: true
    }
    const { input } = renderRow(
      settingsWith({ [SSH_HOST_ID]: { defaultWorktreeLocation: '/srv/merged' } }),
      mergedScope
    )
    expect(input.value).toBe('/srv/merged')
  })

  it('browses a server host with that environment, never the local dialog', async () => {
    const user = userEvent.setup()
    renderRow(settingsWith({}), serverScope)
    await user.click(screen.getByRole('button', { name: /browse/i }))
    expect(pickFolder).not.toHaveBeenCalled()
    expect(screen.getByTestId('remote-file-browser').dataset.environment).toBe(SERVER_ID)
  })

  it('browses an SSH machine with that target', async () => {
    const user = userEvent.setup()
    renderRow(settingsWith({}), machineOnlyScope)
    await user.click(screen.getByRole('button', { name: /browse/i }))
    expect(screen.getByTestId('remote-file-browser').dataset.target).toBe('builder')
  })

  it('uses the local picker only for this computer', async () => {
    const user = userEvent.setup()
    renderRow(settingsWith({}), localScope)
    await user.click(screen.getByRole('button', { name: /browse/i }))
    expect(pickFolder).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('remote-file-browser')).toBeNull()
  })

  it('disables the field and browse for a host that is no longer saved', async () => {
    const user = userEvent.setup()
    const { input } = renderRow(settingsWith({}), { ...serverScope, available: false })
    expect(input.disabled).toBe(true)
    const browse = screen.getByRole('button', { name: /browse/i })
    await user.click(browse)
    expect(pickFolder).not.toHaveBeenCalled()
    expect(screen.queryByTestId('remote-file-browser')).toBeNull()
  })
})
