import { describe, expect, it } from 'vitest'
import { formatWorktreeSharedDirectoriesWarning } from './worktree-shared-directories-warning'

describe('formatWorktreeSharedDirectoriesWarning', () => {
  it('returns no warning when every path was materialized', () => {
    expect(formatWorktreeSharedDirectoriesWarning([])).toBeUndefined()
  })

  it('names a single failed path', () => {
    expect(formatWorktreeSharedDirectoriesWarning(['node_modules'])).toBe(
      'Could not materialize worktree.sharedDirectories path: "node_modules". See the app logs for details.'
    )
  })

  it('bounds the path list when many materializations fail', () => {
    expect(formatWorktreeSharedDirectoriesWarning(['a', 'b', 'c', 'd', 'e', 'f'])).toBe(
      'Could not materialize worktree.sharedDirectories paths: "a", "b", "c", "d", "e" and 1 more. See the app logs for details.'
    )
  })
})
