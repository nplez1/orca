// @vitest-environment happy-dom

import { act, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCreateProjectDefaults } from './useCreateProjectDefaults'
import { toRuntimeExecutionHostId } from '../../../../../../shared/execution-host'

const browseRuntimeServerDirectory = vi.hoisted(() => vi.fn())

vi.mock('@/runtime/files/reads/runtime-server-directory-browser', () => ({
  browseRuntimeServerDirectory
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: vi.fn().mockResolvedValue({ available: true })
}))

const SERVER = toRuntimeExecutionHostId('server-a')

type Seen = { parent: string; status: string }

function Harness({
  hostSettingOverrides,
  worktreeLayoutMode,
  seen
}: {
  hostSettingOverrides: Parameters<typeof useCreateProjectDefaults>[0]['hostSettingOverrides']
  worktreeLayoutMode: 'repo-nested' | 'flat'
  seen: Seen
}): React.JSX.Element {
  const [createParent, setCreateParent] = useState('')
  const model = useCreateProjectDefaults({
    step: 'create',
    activeRuntimeEnvironmentId: 'server-a',
    createParent,
    setCreateParent,
    worktreeLayoutMode,
    hostSettingOverrides
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

  it('probes the host home when nothing is stored', async () => {
    const seen: Seen = { parent: '', status: '' }
    await act(async () => {
      render(<Harness hostSettingOverrides={{}} worktreeLayoutMode="repo-nested" seen={seen} />)
    })
    expect(seen.parent).toBe('/home/me/orca/workspaces')
    expect(browseRuntimeServerDirectory).toHaveBeenCalledWith('server-a', '~')
  })
})
