// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode, type ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NeedsSetupProjectHostOption } from '@/lib/project-host-setup-options'

const storeMocks = vi.hoisted(() => ({
  setupProjectExistingFolder: vi.fn(),
  setupProjectClone: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector(storeMocks)
}))

vi.mock('@/components/sidebar/host-path-browser/RemoteFileBrowser', () => ({
  RemoteFileBrowser: ({
    targetId,
    onSelect,
    onCancel
  }: {
    targetId?: string
    onSelect: (path: string) => void
    onCancel: () => void
  }) => (
    <div data-testid="remote-file-browser" data-target={targetId ?? ''}>
      <button type="button" onClick={() => onSelect('/remote/orca')}>
        Select remote folder
      </button>
      <button type="button" onClick={onCancel}>
        Cancel browse
      </button>
    </div>
  )
}))

import { SetProjectLocationDialog } from './SetProjectLocationDialog'

const option: NeedsSetupProjectHostOption = {
  kind: 'needs-setup',
  id: 'needs-setup:runtime:env-b',
  projectId: 'project-orca',
  hostId: 'runtime:env-b',
  label: 'build box',
  detail: 'Project location not set',
  isAvailable: true,
  attention: false,
  canSetLocation: true
}

function renderDialog(
  overrides: Partial<ComponentProps<typeof SetProjectLocationDialog>> = {}
): ReturnType<typeof userEvent.setup> {
  const user = userEvent.setup()
  render(
    <SetProjectLocationDialog
      option={option}
      projectName="orca"
      projectKind="git"
      onClose={vi.fn()}
      onReady={vi.fn()}
      {...overrides}
    />
  )
  return user
}

beforeEach(() => {
  storeMocks.setupProjectExistingFolder.mockReset()
  storeMocks.setupProjectClone.mockReset()
  storeMocks.setupProjectExistingFolder.mockResolvedValue({
    setup: { id: 'setup-env-b' }
  })
})

afterEach(() => {
  cleanup()
})

describe('SetProjectLocationDialog', () => {
  it('is the existing-folder fallback only, never a clone step', () => {
    renderDialog()

    expect(screen.getByTestId('set-project-location-dialog')).toBeTruthy()
    expect(screen.getByText('Use an existing folder')).toBeTruthy()
    // Why: cloning starts from the host picker now, so offering it here would be a second way in.
    expect(screen.queryByRole('button', { name: /Clone from URL/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Set project location/ })).toBeNull()
  })

  it('opens on the folder a failed clone already found', () => {
    renderDialog({ initialPath: '/srv/checkouts/orca' })

    expect(screen.getByPlaceholderText('/path/to/project/on/host')).toHaveProperty(
      'value',
      '/srv/checkouts/orca'
    )
  })

  it('saves the existing folder and reports it as an adoption, not a clone', async () => {
    const onClose = vi.fn()
    const onReady = vi.fn()
    const user = renderDialog({ onClose, onReady })

    await user.type(screen.getByPlaceholderText('/path/to/project/on/host'), '/remote/orca')
    await user.click(screen.getByRole('button', { name: 'Set location' }))

    expect(storeMocks.setupProjectExistingFolder).toHaveBeenCalledWith({
      projectId: 'project-orca',
      hostId: 'runtime:env-b',
      path: '/remote/orca',
      kind: 'git',
      displayName: 'orca'
    })
    // Why the method: only our own clone can make the clone itself the copy.
    expect(onReady).toHaveBeenCalledWith(
      JSON.stringify(['setup-env-b', 'runtime:env-b']),
      'existing-folder'
    )
    expect(storeMocks.setupProjectClone).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('backs out of the host browser on Escape instead of discarding the form', async () => {
    const onClose = vi.fn()
    const user = renderDialog({ onClose })

    await user.click(screen.getByRole('button', { name: 'Browse host filesystem' }))
    expect(screen.getByTestId('remote-file-browser')).toBeTruthy()

    await user.keyboard('{Escape}')

    expect(onClose).not.toHaveBeenCalled()
    expect(screen.queryByTestId('remote-file-browser')).toBeNull()
    expect(screen.getByRole('button', { name: 'Set location' })).toBeTruthy()

    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalled()
  })

  it('does not retarget the composer when a slow setup lands after dismissal', async () => {
    let finishSetup: (result: { setup: { id: string } }) => void = () => {}
    storeMocks.setupProjectExistingFolder.mockReturnValue(
      new Promise((resolve) => {
        finishSetup = resolve
      })
    )
    const onReady = vi.fn()
    const onClose = vi.fn()
    const { rerender } = render(
      <SetProjectLocationDialog
        option={option}
        projectName="orca"
        projectKind="git"
        onClose={onClose}
        onReady={onReady}
      />
    )
    const user = userEvent.setup()

    await user.type(screen.getByPlaceholderText('/path/to/project/on/host'), '/remote/orca')
    await user.click(screen.getByRole('button', { name: 'Set location' }))

    rerender(
      <SetProjectLocationDialog
        option={null}
        projectName="orca"
        projectKind="git"
        onClose={onClose}
        onReady={onReady}
      />
    )
    finishSetup({ setup: { id: 'setup-env-b' } })

    expect(onReady).not.toHaveBeenCalled()
  })

  it('still reports success under StrictMode double-invoked effects', async () => {
    const onReady = vi.fn()
    render(
      <StrictMode>
        <SetProjectLocationDialog
          option={option}
          projectName="orca"
          projectKind="git"
          onClose={vi.fn()}
          onReady={onReady}
        />
      </StrictMode>
    )
    const user = userEvent.setup()

    await user.type(screen.getByPlaceholderText('/path/to/project/on/host'), '/remote/orca')
    await user.click(screen.getByRole('button', { name: 'Set location' }))

    expect(onReady).toHaveBeenCalledWith(
      JSON.stringify(['setup-env-b', 'runtime:env-b']),
      'existing-folder'
    )
  })
})
