import { describe, expect, it } from 'vitest'
import { prepareEmptiedWorkspaceRecord } from './workspace-emptied-record'
import { hasWorkspaceEmptiedRecord } from '../../../../../../shared/workspace-layout/terminal-surfaces/closed-terminal-tab-tombstones'
import type { ClosedTerminalTabTombstonesByTabId } from '../../../../../../shared/workspace-layout/terminal-surfaces/closed-terminal-tab-tombstones'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../../shared/workspace/identity/floating-workspace-id'

const WT = 'repo1::/path/wt1'
const DAY = 24 * 60 * 60 * 1000
const NOW = 100 * DAY

describe('prepareEmptiedWorkspaceRecord', () => {
  it('records a workspace left with nothing to render', () => {
    const prepared = prepareEmptiedWorkspaceRecord({ tabsByWorktree: { [WT]: [] } }, WT, NOW)
    expect(prepared?.record).toEqual({
      closedAt: NOW,
      worktreeId: WT,
      reason: 'user',
      scope: 'workspace'
    })
    expect(
      hasWorkspaceEmptiedRecord(prepared?.patch.closedTerminalTabTombstonesByTabId, WT, NOW)
    ).toBe(true)
  })

  it('records nothing when a close left a sibling tab behind', () => {
    expect(
      prepareEmptiedWorkspaceRecord(
        {
          tabsByWorktree: { [WT]: [] },
          unifiedTabsByWorktree: { [WT]: [{ id: 'chat-1' }] }
        },
        WT,
        NOW
      )
    ).toBeNull()
  })

  it('records nothing for the floating panel', () => {
    expect(
      prepareEmptiedWorkspaceRecord(
        { tabsByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: [] } },
        FLOATING_TERMINAL_WORKTREE_ID,
        NOW
      )
    ).toBeNull()
  })

  it('renews the same record when an empty workspace is emptied again later', () => {
    const first = prepareEmptiedWorkspaceRecord({ tabsByWorktree: { [WT]: [] } }, WT, NOW)
    const records = first?.patch.closedTerminalTabTombstonesByTabId ?? {}
    const again = prepareEmptiedWorkspaceRecord(
      { tabsByWorktree: { [WT]: [] }, closedTerminalTabTombstonesByTabId: records },
      WT,
      NOW + 29 * DAY
    )
    expect(again?.recordId).toBe(first?.recordId)
    // The count restarts from the emptying that matters, not from the first one.
    const renewed: ClosedTerminalTabTombstonesByTabId =
      again?.patch.closedTerminalTabTombstonesByTabId ?? {}
    expect(hasWorkspaceEmptiedRecord(renewed, WT, NOW + 31 * DAY)).toBe(true)
    expect(Object.keys(renewed)).toHaveLength(1)
  })
})
