import { describe, expect, it } from 'vitest'
import {
  findPreferredRenderRowIndexForWorktree,
  findPreferredRenderRowIndexForWorktreeIdentity,
  renderRowContainsWorktree
} from './render-row-lookup'
import type { WorktreeRow } from '../grouping/row-types'
import { remoteWorktree, worktree } from '../../worktree-list-groups-test-fixtures'

function mergedRow(): WorktreeRow {
  return {
    type: 'item',
    rowKey: `project:p1:${worktree.id}`,
    sectionKey: 'project:p1',
    worktree,
    repo: undefined,
    depth: 0,
    groupDepth: 0,
    lineageTrail: [],
    isLastLineageChild: false,
    lineageChildCount: 0,
    branchGroup: [
      { hostId: 'local', hostLabel: 'Local Mac', repo: undefined, worktree },
      { hostId: 'ssh:gpu-vm', hostLabel: 'GPU VM', repo: undefined, worktree: remoteWorktree }
    ]
  }
}

describe('branch-group reveal lookup', () => {
  it('resolves a merged row from any host it stands in for', () => {
    const row = mergedRow()

    expect(renderRowContainsWorktree(row, worktree.id, 'local')).toBe(true)
    expect(renderRowContainsWorktree(row, remoteWorktree.id, 'ssh:gpu-vm')).toBe(true)
    expect(renderRowContainsWorktree(row, remoteWorktree.id, 'local')).toBe(false)
  })

  it('finds the merged row when revealing a non-primary host', () => {
    const row = mergedRow()

    expect(
      findPreferredRenderRowIndexForWorktree([row], remoteWorktree.id, 'single-location')
    ).toBe(0)
    expect(
      findPreferredRenderRowIndexForWorktreeIdentity(
        [row],
        { id: remoteWorktree.id, hostId: 'ssh:gpu-vm' },
        'single-location'
      )
    ).toBe(0)
  })
})
