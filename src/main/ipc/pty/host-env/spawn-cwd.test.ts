import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'

const { ensureFloatingWorkspaceLaunchDirectorySyncMock } = vi.hoisted(() => ({
  ensureFloatingWorkspaceLaunchDirectorySyncMock: vi.fn(
    () => '/home/example/.orca/floating-workspace'
  )
}))

vi.mock('../../../floating-workspace-launch-directory', () => ({
  ensureFloatingWorkspaceLaunchDirectorySync: ensureFloatingWorkspaceLaunchDirectorySyncMock
}))

import { resolvePtySpawnStartupCwd } from './spawn-cwd'

describe('resolvePtySpawnStartupCwd', () => {
  beforeEach(() => {
    ensureFloatingWorkspaceLaunchDirectorySyncMock.mockClear()
  })

  it('starts a floating terminal in the floating-workspace folder when no cwd is requested', () => {
    expect(resolvePtySpawnStartupCwd(undefined, FLOATING_TERMINAL_WORKTREE_ID, undefined)).toBe(
      '/home/example/.orca/floating-workspace'
    )
    expect(resolvePtySpawnStartupCwd(undefined, FLOATING_TERMINAL_WORKTREE_ID, '   ')).toBe(
      '/home/example/.orca/floating-workspace'
    )
  })

  it('keeps an explicit floating cwd', () => {
    expect(
      resolvePtySpawnStartupCwd(undefined, FLOATING_TERMINAL_WORKTREE_ID, '/tmp/scratch')
    ).toBe('/tmp/scratch')
  })

  it('leaves other workspaces to the shared resolver', () => {
    expect(resolvePtySpawnStartupCwd(undefined, undefined, undefined)).toBeUndefined()
    expect(ensureFloatingWorkspaceLaunchDirectorySyncMock).not.toHaveBeenCalled()
  })
})
