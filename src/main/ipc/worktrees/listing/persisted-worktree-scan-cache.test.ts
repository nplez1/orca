import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import {
  persistWorktreeScanCacheEntry,
  readPersistedWorktreeScanCache,
  resetPersistedWorktreeScanCacheForTests
} from './persisted-worktree-scan-cache'

const WORKTREE: GitWorktreeInfo = {
  path: '/workspace/repo',
  head: 'a'.repeat(40),
  branch: 'refs/heads/main',
  isBare: false,
  isMainWorktree: true
}

let profileDirectory: string | undefined

afterEach(async () => {
  resetPersistedWorktreeScanCacheForTests()
  if (profileDirectory) {
    await rm(profileDirectory, { recursive: true, force: true })
    profileDirectory = undefined
  }
})

describe('persisted worktree scan cache', () => {
  it('round-trips a local listing with its Git routing identity', async () => {
    profileDirectory = await mkdtemp(join(tmpdir(), 'orca-worktree-cache-'))

    await persistWorktreeScanCacheEntry(profileDirectory, 'repo-1', {
      repoPath: '/workspace/repo',
      wslDistro: 'Ubuntu',
      worktrees: [WORKTREE]
    })

    await expect(readPersistedWorktreeScanCache(profileDirectory)).resolves.toEqual([
      expect.objectContaining({
        repoId: 'repo-1',
        repoPath: '/workspace/repo',
        wslDistro: 'Ubuntu',
        worktrees: [WORKTREE]
      })
    ])
  })

  it('drops malformed entries without rejecting the cache read', async () => {
    profileDirectory = await mkdtemp(join(tmpdir(), 'orca-worktree-cache-'))
    await writeFile(
      join(profileDirectory, 'orca-worktree-scan-cache.json'),
      JSON.stringify({
        schemaVersion: 1,
        entries: {
          'repo-1': {
            repoPath: '/workspace/repo',
            wslDistro: null,
            scannedAt: Date.now(),
            worktrees: [WORKTREE]
          },
          malformed: {
            repoPath: '/workspace/bad',
            wslDistro: null,
            scannedAt: Date.now(),
            worktrees: [{ path: 42 }]
          }
        }
      })
    )

    await expect(readPersistedWorktreeScanCache(profileDirectory)).resolves.toHaveLength(1)
  })
})
