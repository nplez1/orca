// @vitest-environment happy-dom

import { act, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCreateProjectDefaults } from './useCreateProjectDefaults'
import {
  toRuntimeExecutionHostId,
  toSshExecutionHostId
} from '../../../../../../shared/execution-host'

const browseRuntimeServerDirectory = vi.hoisted(() => vi.fn())

vi.mock('@/runtime/files/reads/runtime-server-directory-browser', () => ({
  browseRuntimeServerDirectory
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: vi.fn().mockResolvedValue({ available: true })
}))

const SERVER = toRuntimeExecutionHostId('server-a')
const MERGED_SSH = toSshExecutionHostId('builder')

type Seen = { parent: string; status: string }

function Harness({
  hostSettingOverrides,
  worktreeLayoutMode,
  overrideHostIds,
  seen
}: {
  hostSettingOverrides: Parameters<typeof useCreateProjectDefaults>[0]['hostSettingOverrides']
  worktreeLayoutMode: 'repo-nested' | 'flat'
  overrideHostIds?: Parameters<typeof useCreateProjectDefaults>[0]['overrideHostIds']
  seen: Seen
}): React.JSX.Element {
  const [createParent, setCreateParent] = useState('')
  const model = useCreateProjectDefaults({
    step: 'create',
    activeRuntimeEnvironmentId: 'server-a',
    createParent,
    setCreateParent,
    worktreeLayoutMode,
    hostSettingOverrides,
    overrideHostIds
  })
  seen.parent = createParent
  seen.status = model.createRuntimeParentStatus
  return <div />
}

beforeEach(() => {
  browseRuntimeServerDirectory.mockReset()
  browseRuntimeServerDirectory.mockResolvedValue({ resolvedPath: '/home/me', entries: [] })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('useCreateProjectDefaults on a runtime host', () => {
  it('uses the stored worktree root instead of probing the host', async () => {
    const seen: Seen = { parent: '', status: '' }
    await act(async () => {
      render(
        <Harness
          hostSettingOverrides={{ [SERVER]: { defaultWorktreeLocation: '/srv/orca/workspaces' } }}
          worktreeLayoutMode="repo-nested"
          seen={seen}
        />
      )
    })
    expect(seen.parent).toBe('/srv/orca/workspaces')
    expect(browseRuntimeServerDirectory).not.toHaveBeenCalled()
  })

  it('uses the stored checkout root under a flat layout', async () => {
    const seen: Seen = { parent: '', status: '' }
    await act(async () => {
      render(
        <Harness
          hostSettingOverrides={{ [SERVER]: { defaultRepoRoot: '/srv/orca/projects' } }}
          worktreeLayoutMode="flat"
          seen={seen}
        />
      )
    })
    expect(seen.parent).toBe('/srv/orca/projects')
    expect(browseRuntimeServerDirectory).not.toHaveBeenCalled()
  })

  it('uses a worktree root the user named under a flat layout, without probing', async () => {
    const seen: Seen = { parent: '', status: '' }
    await act(async () => {
      render(
        <Harness
          hostSettingOverrides={{ [SERVER]: { defaultWorktreeLocation: '/srv/wt' } }}
          worktreeLayoutMode="flat"
          seen={seen}
        />
      )
    })
    expect(seen.parent).toBe('/srv/wt')
    expect(browseRuntimeServerDirectory).not.toHaveBeenCalled()
  })

  it('probes the host home when nothing is stored', async () => {
    const seen: Seen = { parent: '', status: '' }
    await act(async () => {
      render(<Harness hostSettingOverrides={{}} worktreeLayoutMode="repo-nested" seen={seen} />)
    })
    expect(seen.parent).toBe('/home/me/orca/workspaces')
    expect(browseRuntimeServerDirectory).toHaveBeenCalledWith('server-a', '~')
  })

  it('uses a folder stored under the ssh id a server merged with', async () => {
    const seen: Seen = { parent: '', status: '' }
    await act(async () => {
      render(
        <Harness
          hostSettingOverrides={{ [MERGED_SSH]: { defaultRepoRoot: '/srv/repos' } }}
          worktreeLayoutMode="repo-nested"
          overrideHostIds={[SERVER, MERGED_SSH]}
          seen={seen}
        />
      )
    })
    expect(seen.parent).toBe('/srv/repos')
    expect(browseRuntimeServerDirectory).not.toHaveBeenCalled()
  })
})
