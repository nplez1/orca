import { describe, expect, it } from 'vitest'
import {
  hasNoRenderableWorkspaceContent,
  isActiveEmptyWorkspace,
  isWorkspaceEmptiedForSeeding,
  isWorkspaceEmptiedOnPurpose
} from './workspace-emptied-on-purpose'
import { CLOSED_TERMINAL_TAB_TOMBSTONE_TTL_MS } from '../../../shared/workspace-layout/terminal-surfaces/closed-terminal-tab-tombstones'

const WT = 'repo1::/path/wt1'
const NOW = 10_000
const FRESH_CLOSE = { closed: { closedAt: NOW - 1_000, worktreeId: WT } }
const FRESH_WORKSPACE_CLOSE = {
  minted: {
    closedAt: NOW - 1_000,
    worktreeId: WT,
    reason: 'user' as const,
    scope: 'workspace' as const
  }
}

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

describe('isWorkspaceEmptiedForSeeding', () => {
  it('reads a workspace emptied by its last chat, browser or editor close as emptied', () => {
    // No terminal row at all: only the workspace record speaks for this build's empty state.
    expect(
      isWorkspaceEmptiedForSeeding(
        { tabsByWorktree: {}, closedTerminalTabTombstonesByTabId: FRESH_WORKSPACE_CLOSE },
        WT,
        NOW
      )
    ).toBe(true)
  })

  it('does not read a workspace record while anything is still renderable', () => {
    expect(
      isWorkspaceEmptiedForSeeding(
        {
          tabsByWorktree: {},
          unifiedTabsByWorktree: { [WT]: [{ id: 'chat-1' }] },
          closedTerminalTabTombstonesByTabId: FRESH_WORKSPACE_CLOSE
        },
        WT,
        NOW
      )
    ).toBe(false)
  })

  it('does not read a workspace record past its TTL as emptied', () => {
    expect(
      isWorkspaceEmptiedForSeeding(
        {
          tabsByWorktree: {},
          closedTerminalTabTombstonesByTabId: {
            minted: {
              closedAt: NOW - CLOSED_TERMINAL_TAB_TOMBSTONE_TTL_MS - 1,
              worktreeId: WT,
              scope: 'workspace'
            }
          }
        },
        WT,
        NOW
      )
    ).toBe(false)
  })

  it('still requires a terminal row for a terminal close record', () => {
    expect(
      isWorkspaceEmptiedForSeeding(
        { tabsByWorktree: {}, closedTerminalTabTombstonesByTabId: FRESH_CLOSE },
        WT,
        NOW
      )
    ).toBe(false)
    expect(
      isWorkspaceEmptiedForSeeding(
        { tabsByWorktree: { [WT]: [] }, closedTerminalTabTombstonesByTabId: FRESH_CLOSE },
        WT,
        NOW
      )
    ).toBe(true)
  })
})

describe('isWorkspaceEmptiedOnPurpose', () => {
  it('reads an empty workspace whose last chat, browser or editor tab was closed as emptied', () => {
    expect(
      isWorkspaceEmptiedOnPurpose(
        { tabsByWorktree: { [WT]: [] }, closedTerminalTabTombstonesByTabId: FRESH_WORKSPACE_CLOSE },
        WT,
        NOW
      )
    ).toBe(true)
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
