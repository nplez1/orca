// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NeedsSetupProjectHostOption } from '@/lib/project-host-setup-options'
import { RunTargetCloneStatus } from './RunTargetCloneStatus'
import type {
  RunTargetAutoClone,
  RunTargetCloneStatus as CloneStatus
} from './use-run-target-auto-clone'

const option: NeedsSetupProjectHostOption = {
  kind: 'needs-setup',
  id: 'needs-setup:runtime:env-b',
  projectId: 'github:acme/app',
  hostId: 'runtime:env-b',
  label: 'Build box',
  detail: 'Project location not set',
  isAvailable: true,
  attention: false,
  canSetLocation: true
}

function renderStatus(status: CloneStatus) {
  const clone: RunTargetAutoClone = {
    status,
    overrides: { url: '', destination: '' },
    setOverrides: vi.fn(),
    defaultUrl: '',
    pendingHostId: status.kind === 'idle' ? null : status.target.hostId,
    blocksCreate: status.kind !== 'idle',
    start: vi.fn(),
    retry: vi.fn(),
    cloneAs: vi.fn(),
    clear: vi.fn()
  }
  const onUseExistingFolder = vi.fn()
  render(<RunTargetCloneStatus clone={clone} onUseExistingFolder={onUseExistingFolder} />)
  return { clone, onUseExistingFolder }
}

const target = { hostId: 'runtime:env-b' as const, label: 'Build box', option }

afterEach(() => {
  cleanup()
})

describe('RunTargetCloneStatus', () => {
  it('renders nothing when no clone is pending', () => {
    renderStatus({ kind: 'idle' })

    expect(screen.queryByRole('status')).toBeNull()
  })

  it('names the host the clone is running on', () => {
    renderStatus({ kind: 'cloning', target })

    expect(screen.getByText('Cloning onto Build box…')).toBeTruthy()
  })

  it('keeps the failure, Retry and the existing folder in front of the user', async () => {
    const { clone, onUseExistingFolder } = renderStatus({
      kind: 'failed',
      target,
      message: 'Host key verification failed.'
    })
    const user = userEvent.setup()

    expect(screen.getByText('Host key verification failed.')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(clone.retry).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: 'Use existing folder' }))
    expect(onUseExistingFolder).toHaveBeenCalledWith(option)
  })

  it('offers the suggested folder name and, when it may be this project, the folder itself', async () => {
    const { clone, onUseExistingFolder } = renderStatus({
      kind: 'folder-taken',
      target,
      folderName: 'app',
      path: '/srv/checkouts/app',
      suggestion: 'app-2',
      canUseExistingFolder: true
    })
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: 'Clone as app-2' }))
    expect(clone.cloneAs).toHaveBeenCalledWith('app-2')

    // Why the path: the dialog must open on the folder that is actually there, not on its name.
    await user.click(screen.getByRole('button', { name: 'Use existing folder' }))
    expect(onUseExistingFolder).toHaveBeenCalledWith(option, '/srv/checkouts/app')
  })

  it('withholds the existing-folder answer when the folder belongs to another repository', () => {
    renderStatus({
      kind: 'folder-taken',
      target,
      folderName: 'app',
      path: '/srv/checkouts/app',
      suggestion: 'app-2',
      canUseExistingFolder: false
    })

    expect(screen.queryByRole('button', { name: 'Use existing folder' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Clone as app-2' })).toBeTruthy()
  })
})
