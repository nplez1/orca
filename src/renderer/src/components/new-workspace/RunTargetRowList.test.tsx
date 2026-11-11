// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NeedsSetupProjectHostOption } from '@/lib/project-host-setup-options'
import RunTargetRowList from './RunTargetRowList'
import type { RunTargetRowModel } from './run-target-options'
import type { RunTargetCloneStatus } from './use-run-target-auto-clone'

const CLONE_URL = 'git@github.com:acme/app.git'
const IDLE_CLONE: RunTargetCloneStatus = { kind: 'idle' }

const cloneable: NeedsSetupProjectHostOption = {
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

const sshHost: NeedsSetupProjectHostOption = {
  ...cloneable,
  id: 'needs-setup:ssh:devbox',
  hostId: 'ssh:devbox',
  label: 'devbox',
  detail: 'Set this project up from a Remote Orca Server on that host',
  canSetLocation: false
}

function rows(option: NeedsSetupProjectHostOption): RunTargetRowModel[] {
  return [{ key: `needs:${option.id}`, kind: 'needs-setup', option }]
}

function renderList({
  option = cloneable,
  projectKind = 'git' as const,
  cloneStatus = IDLE_CLONE
}: {
  option?: NeedsSetupProjectHostOption
  projectKind?: 'git' | 'folder'
  cloneStatus?: RunTargetCloneStatus
} = {}) {
  const handlers = {
    onStartClone: vi.fn(),
    onUseExistingFolder: vi.fn(),
    onRetryClone: vi.fn(),
    onCloneAs: vi.fn(),
    onConnectHost: vi.fn(),
    onSelectHost: vi.fn(),
    onSelectRecipe: vi.fn(),
    onArm: vi.fn(),
    onRecipesOpenChange: vi.fn()
  }
  render(
    <RunTargetRowList
      rows={rows(option)}
      armedKey={null}
      listId="list"
      selectedHost={null}
      selectedRecipeId={null}
      matchedRecipes={[]}
      recipesOpen={false}
      connectingHostIds={new Set()}
      canConnect
      projectKind={projectKind}
      cloneUrl={CLONE_URL}
      cloneStatus={cloneStatus}
      {...handlers}
    />
  )
  return handlers
}

afterEach(() => {
  cleanup()
})

describe('RunTargetRowList', () => {
  it('has no pre-emptive set-location control anywhere', () => {
    renderList()

    expect(screen.queryByText('Set project location')).toBeNull()
    expect(screen.queryByRole('button', { name: /Set project location/ })).toBeNull()
  })

  it('starts the clone when a cloneable host row is chosen', async () => {
    const handlers = renderList()
    const user = userEvent.setup()

    await user.click(screen.getByText('Build box'))

    expect(handlers.onStartClone).toHaveBeenCalledWith(cloneable)
    expect(handlers.onUseExistingFolder).not.toHaveBeenCalled()
  })

  it('says a folder project cannot be cloned and offers only the existing folder', async () => {
    const handlers = renderList({ projectKind: 'folder' })
    const user = userEvent.setup()

    expect(screen.getByText(/Only a Git project can be cloned/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Use an existing folder on Build box' }))

    expect(handlers.onUseExistingFolder).toHaveBeenCalledWith(cloneable)
    expect(handlers.onStartClone).not.toHaveBeenCalled()
  })

  it('leaves an SSH host inert with the reason it already shows', async () => {
    const handlers = renderList({ option: sshHost })
    const user = userEvent.setup()

    expect(screen.getByText(/Remote Orca Server on that host/)).toBeTruthy()
    await user.click(screen.getByText('devbox'))

    // Why: cloning there is refused and so is adopting a folder, so the row must promise nothing.
    expect(handlers.onStartClone).not.toHaveBeenCalled()
    expect(handlers.onUseExistingFolder).not.toHaveBeenCalled()
  })

  it('reports a running clone on its own row', () => {
    renderList({
      cloneStatus: {
        kind: 'cloning',
        target: { hostId: 'runtime:env-b', label: 'Build box', option: cloneable }
      }
    })

    expect(screen.getByText('Cloning…')).toBeTruthy()
  })

  it('offers Retry on the row whose clone failed, and never a local path', async () => {
    const handlers = renderList({
      cloneStatus: {
        kind: 'failed',
        target: { hostId: 'runtime:env-b', label: 'Build box', option: cloneable },
        message: 'Could not read from remote repository.'
      }
    })
    const user = userEvent.setup()

    expect(screen.getByText('Could not read from remote repository.')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Retry cloning onto Build box' }))

    expect(handlers.onRetryClone).toHaveBeenCalledTimes(1)
  })

  it('names the taken folder and offers the suggested one instead of renaming silently', async () => {
    const handlers = renderList({
      cloneStatus: {
        kind: 'folder-taken',
        target: { hostId: 'runtime:env-b', label: 'Build box', option: cloneable },
        folderName: 'app',
        path: '/srv/checkouts/app',
        suggestion: 'app-2',
        canUseExistingFolder: false
      }
    })
    const user = userEvent.setup()

    expect(screen.getByText('app already exists on Build box.')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Clone as app-2' }))

    expect(handlers.onCloneAs).toHaveBeenCalledWith('app-2')
  })
})
