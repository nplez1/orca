import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveCloneTargetPlacement } from './clone-target-placement'

const getRemoteDefaultBranchName = vi.hoisted(() => vi.fn())

vi.mock('../../git/remote-default-branch', () => ({ getRemoteDefaultBranchName }))

const URL = 'https://github.com/stablyai/orca.git'

beforeEach(() => {
  getRemoteDefaultBranchName.mockReset()
  getRemoteDefaultBranchName.mockResolvedValue('main')
})

describe('resolveCloneTargetPlacement', () => {
  it('nests a project-folder clone inside the project folder, named from the URL', async () => {
    await expect(
      resolveCloneTargetPlacement({
        url: URL,
        destination: '/Users/me/orca/workspaces',
        settings: { worktreeLayoutMode: 'project-folder', nestWorkspaces: true }
      })
    ).resolves.toEqual({ relativeClonePath: 'orca/main', projectName: 'orca' })
  })

  it('nests a repo-nested clone the same way', async () => {
    await expect(
      resolveCloneTargetPlacement({
        url: URL,
        destination: '/Users/me/orca/workspaces',
        settings: { worktreeLayoutMode: 'repo-nested', nestWorkspaces: true }
      })
    ).resolves.toEqual({ relativeClonePath: 'orca/main', projectName: 'orca' })
  })

  it('leaves a flat clone in the destination', async () => {
    await expect(
      resolveCloneTargetPlacement({
        url: URL,
        destination: '/Users/me/src',
        settings: { worktreeLayoutMode: 'flat', nestWorkspaces: false }
      })
    ).resolves.toEqual({})
    expect(getRemoteDefaultBranchName).not.toHaveBeenCalled()
  })
})
