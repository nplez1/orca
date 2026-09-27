import { describe, expect, it } from 'vitest'
import type { FsChangeEvent } from '../../shared/filesystem-entry-types'
import {
  isWorkspacePathIndexPolicyEvent,
  isWorkspacePathIndexPolicyPath,
  needsWorkspacePathIndexReconciliation
} from './filesystem-watcher-path-index-reconciliation'

describe('filesystem watcher path-index event policy', () => {
  it('leaves ordinary content saves off the membership lane', () => {
    expect(needsWorkspacePathIndexReconciliation(event('update', '/workspace/src/file.ts'))).toBe(
      false
    )
    expect(needsWorkspacePathIndexReconciliation(event('update', '/workspace/.gitignore'))).toBe(
      true
    )
  })

  it('invalidates classification for local ignore and Git policy files', () => {
    for (const path of [
      '/workspace/.gitignore',
      '/workspace/.ignore',
      '/workspace/.rgignore',
      '/workspace/.git/info/exclude',
      '/workspace/.git/config',
      '/home/user/.gitconfig',
      '/home/user/.config/git/config',
      '/home/user/.config/git/ignore',
      '/home/user/.gitignore_global'
    ]) {
      expect(isWorkspacePathIndexPolicyPath(path)).toBe(true)
      expect(isWorkspacePathIndexPolicyEvent(event('update', path))).toBe(true)
    }
  })

  it('routes creates, deletes, and renames to targeted reconciliation', () => {
    expect(needsWorkspacePathIndexReconciliation(event('create', '/workspace/new.ts'))).toBe(true)
    expect(needsWorkspacePathIndexReconciliation(event('delete', '/workspace/old.ts'))).toBe(true)
    expect(
      needsWorkspacePathIndexReconciliation({
        ...event('rename', '/workspace/new.ts'),
        oldAbsolutePath: '/workspace/old.ts'
      })
    ).toBe(true)
  })
})

function event(kind: FsChangeEvent['kind'], absolutePath: string): FsChangeEvent {
  return { kind, absolutePath }
}
