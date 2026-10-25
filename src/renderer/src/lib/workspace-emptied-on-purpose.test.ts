import { describe, expect, it } from 'vitest'
import {
  hasNoRenderableWorkspaceContent,
  isActiveEmptyWorkspace,
  isWorkspaceEmptiedOnPurpose
} from './workspace-emptied-on-purpose'
import { CLOSED_TERMINAL_TAB_TOMBSTONE_TTL_MS } from '../../../shared/closed-terminal-tab-tombstones'

const WT = 'repo1::/path/wt1'
const NOW = 10_000
const FRESH_CLOSE = { closed: { closedAt: NOW - 1_000, worktreeId: WT } }

describe('isWorkspaceEmptiedOnPurpose', () => {
  it('reads an empty workspace whose last tab was closed as emptied', () => {
    expect(
      isWorkspaceEmptiedOnPurpose(
        { tabsByWorktree: { [WT]: [] }, closedTerminalTabTombstonesByTabId: FRESH_CLOSE },
        WT,
        NOW
      )
    ).toBe(true)
  })

  it('does not read an empty workspace with no close record as emptied', () => {
    expect(isWorkspaceEmptiedOnPurpose({ tabsByWorktree: { [WT]: [] } }, WT, NOW)).toBe(false)
  })

  it('does not read a close record past its TTL as emptied', () => {
    expect(
      isWorkspaceEmptiedOnPurpose(
        {
          tabsByWorktree: { [WT]: [] },
          closedTerminalTabTombstonesByTabId: {
            closed: { closedAt: NOW - CLOSED_TERMINAL_TAB_TOMBSTONE_TTL_MS - 1, worktreeId: WT }
          }
        },
        WT,
        NOW
      )
    ).toBe(false)
  })

  it('keeps a workspace still holding a chat tab out of the emptied state', () => {
    // The close record only says a terminal was closed here; a slept chat is still a tab.
    expect(
      isWorkspaceEmptiedOnPurpose(
        {
          tabsByWorktree: { [WT]: [] },
          unifiedTabsByWorktree: { [WT]: [{ id: 'chat-1' }] },
          closedTerminalTabTombstonesByTabId: FRESH_CLOSE
        },
        WT,
        NOW
      )
    ).toBe(false)
  })

  it('keeps a workspace with an open editor file out of the emptied state', () => {
    expect(
      isWorkspaceEmptiedOnPurpose(
        {
          tabsByWorktree: { [WT]: [] },
          openFiles: [{ worktreeId: WT }],
          closedTerminalTabTombstonesByTabId: FRESH_CLOSE
        },
        WT,
        NOW
      )
    ).toBe(false)
  })
})

describe('isActiveEmptyWorkspace', () => {
  it('reads the workspace on screen with nothing to render as empty', () => {
    expect(isActiveEmptyWorkspace({ activeWorktreeId: WT, tabsByWorktree: { [WT]: [] } }, WT)).toBe(
      true
    )
  })

  it('leaves a workspace off screen to the sleep rules', () => {
    expect(
      isActiveEmptyWorkspace(
        { activeWorktreeId: 'repo1::/path/other', tabsByWorktree: { [WT]: [] } },
        WT
      )
    ).toBe(false)
  })

  it('does not read a workspace still holding a browser tab as empty', () => {
    expect(
      isActiveEmptyWorkspace(
        { activeWorktreeId: WT, browserTabsByWorktree: { [WT]: [{ id: 'browser-1' }] } },
        WT
      )
    ).toBe(false)
  })
})

describe('hasNoRenderableWorkspaceContent', () => {
  it('treats a workspace with no row at all as having nothing to render', () => {
    expect(hasNoRenderableWorkspaceContent({}, WT)).toBe(true)
  })

  it('sees a terminal row as content', () => {
    expect(
      hasNoRenderableWorkspaceContent({ tabsByWorktree: { [WT]: [{ id: 'tab-1' }] } }, WT)
    ).toBe(false)
  })
})
