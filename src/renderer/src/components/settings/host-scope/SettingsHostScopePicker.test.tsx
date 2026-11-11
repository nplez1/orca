// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  toSshExecutionHostId
} from '../../../../../shared/execution-host'
import {
  SettingsHostScopePicker,
  shouldShowSettingsHostScopePicker
} from './SettingsHostScopePicker'
import type { SettingsHostScope, SettingsHostScopeHost } from './settings-host-scope'

const SERVER_HOST_ID = toRuntimeExecutionHostId('server-a')
const MERGED_SSH_HOST_ID = toSshExecutionHostId('builder')
const BARE_SSH_HOST_ID = toSshExecutionHostId('bare')

const HOSTS: SettingsHostScopeHost[] = [
  { id: LOCAL_EXECUTION_HOST_ID, label: 'Local Mac' },
  { id: SERVER_HOST_ID, label: 'Boston' },
  {
    id: MERGED_SSH_HOST_ID,
    label: 'builder.example.com',
    aliasHostIds: [toRuntimeExecutionHostId('server-b')]
  },
  { id: BARE_SSH_HOST_ID, label: 'bare.example.com' }
]

const localScope: SettingsHostScope = {
  hostId: LOCAL_EXECUTION_HOST_ID,
  label: 'Local Mac',
  equivalentHostIds: [LOCAL_EXECUTION_HOST_ID],
  target: { kind: 'local' },
  available: true
}

afterEach(cleanup)

describe('shouldShowSettingsHostScopePicker', () => {
  it('hides the picker for a local-only install', () => {
    expect(
      shouldShowSettingsHostScopePicker(localScope, [
        { id: LOCAL_EXECUTION_HOST_ID, label: 'Local Mac' }
      ])
    ).toBe(false)
  })

  it('shows the picker once an SSH machine exists', () => {
    expect(shouldShowSettingsHostScopePicker(localScope, HOSTS)).toBe(true)
  })
})

describe('SettingsHostScopePicker', () => {
  it('lists every machine once, grouped, and offers a server-less SSH row', async () => {
    const user = userEvent.setup()
    render(<SettingsHostScopePicker scope={localScope} hosts={HOSTS} onChoose={() => {}} />)
    await user.click(screen.getByRole('combobox'))
    expect(screen.getByText('This computer')).toBeTruthy()
    expect(screen.getByText('Orca servers')).toBeTruthy()
    expect(screen.getByText('Machines without a server')).toBeTruthy()
    expect(screen.getAllByText('Boston')).toHaveLength(1)
    expect(screen.getByText('bare.example.com')).toBeTruthy()
  })

  it('reports the machine id, not a transport', async () => {
    const user = userEvent.setup()
    const onChoose = vi.fn()
    render(<SettingsHostScopePicker scope={localScope} hosts={HOSTS} onChoose={onChoose} />)
    await user.click(screen.getByRole('combobox'))
    await user.click(screen.getByText('Boston'))
    expect(onChoose).toHaveBeenCalledWith(SERVER_HOST_ID)
  })

  it('keeps a removed server listed but not selectable', async () => {
    const user = userEvent.setup()
    const removed: SettingsHostScope = {
      hostId: toRuntimeExecutionHostId('gone'),
      label: 'Gone',
      equivalentHostIds: [toRuntimeExecutionHostId('gone')],
      target: { kind: 'environment', environmentId: 'gone' },
      available: false
    }
    render(<SettingsHostScopePicker scope={removed} hosts={HOSTS} onChoose={() => {}} />)
    await user.click(screen.getByRole('combobox'))
    // The trigger and the list row both carry it; a removed server never disappears silently.
    expect(screen.getAllByText('Gone (unavailable)').length).toBeGreaterThan(1)
  })
})
