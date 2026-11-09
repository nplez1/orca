import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRuntimeFileWatcherRemoval,
  WATCHER_RESTORE_BUDGET_MS
} from './workspaces/removal/runtime-file-watcher-removal'
import {
  setWorktreeWatcherRemoval,
  type WorktreeWatcherRemoval
} from '../workspaces/removal/worktree-watcher-removal'

const fileCommands = {
  closeFileExplorerWatchersForPath: vi.fn(async () => {}),
  restoreFileExplorerWatchersAfterFailedRemoval: vi.fn(async () => {}),
  forgetFileExplorerWatchersAfterRemoval: vi.fn()
}

function watchers(restoreLocal: () => Promise<void>): WorktreeWatcherRemoval {
  return { closeLocal: async () => {}, restoreLocal, forgetLocal: () => {} }
}

describe('runtime file watcher removal', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
    setWorktreeWatcherRemoval(null)
  })

  it('settles a failed removal whose watcher restore never resolves', async () => {
    setWorktreeWatcherRemoval(watchers(() => new Promise<void>(() => {})))
    const removal = createRuntimeFileWatcherRemoval(fileCommands)
    const gate = await removal.acquire('/repo/wt')

    const finished = gate.finish(false)
    await vi.advanceTimersByTimeAsync(WATCHER_RESTORE_BUDGET_MS)
    await expect(finished).resolves.toBeUndefined()
  })

  it('waits for a restore that settles inside the budget', async () => {
    const restored: string[] = []
    setWorktreeWatcherRemoval(
      watchers(async () => {
        restored.push('local')
      })
    )
    const removal = createRuntimeFileWatcherRemoval(fileCommands)
    const gate = await removal.acquire('/repo/wt')

    await gate.finish(false)
    expect(restored).toEqual(['local'])
  })

  it('logs a restore failure instead of failing the removal that already happened', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    setWorktreeWatcherRemoval(
      watchers(async () => {
        throw new Error('install failed')
      })
    )
    const removal = createRuntimeFileWatcherRemoval(fileCommands)
    const gate = await removal.acquire('/repo/wt')

    await expect(gate.finish(false)).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
