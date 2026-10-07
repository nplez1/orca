import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import {
  selectSessionSummaryPaneKey,
  type SessionSummarySubjectState
} from './session-summary-subject'

const WORKTREE_ID = 'repo-1::/worktree'
const OTHER_WORKTREE_ID = 'repo-1::/other'
const TAB_ID = 'tab-1'
const OTHER_TAB_ID = 'tab-2'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)
const OTHER_PANE_KEY = makePaneKey(TAB_ID, OTHER_LEAF_ID)

function makeTab(id: string, worktreeId = WORKTREE_ID): TerminalTab {
  return {
    id,
    worktreeId,
    ptyId: 'pty-1',
    title: 'claude',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function makeAgentStatusEntry(
  paneKey: string,
  updatedAt = 1_000,
  overrides: Partial<AgentStatusEntry> = {}
): AgentStatusEntry {
  return {
    paneKey,
    state: 'working',
    prompt: '',
    updatedAt,
    stateStartedAt: updatedAt,
    stateHistory: [],
    ...overrides
  }
}

function makeRetainedEntry(paneKey: string, worktreeId = WORKTREE_ID): RetainedAgentEntry {
  return {
    entry: makeAgentStatusEntry(paneKey),
    worktreeId,
    tab: makeTab(TAB_ID, worktreeId),
    agentType: 'claude',
    startedAt: 5_000
  }
}

function makeState(
  overrides: Partial<SessionSummarySubjectState> = {}
): SessionSummarySubjectState {
  return {
    activeWorktreeId: WORKTREE_ID,
    activeTabType: 'terminal',
    activeTabId: TAB_ID,
    tabsByWorktree: {
      [WORKTREE_ID]: [makeTab(TAB_ID)],
      [OTHER_WORKTREE_ID]: [makeTab(OTHER_TAB_ID, OTHER_WORKTREE_ID)]
    },
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null
      }
    },
    agentStatusByPaneKey: {},
    retainedAgentsByPaneKey: {},
    migrationUnsupportedByPtyId: {},
    ...overrides
  }
}

describe('selectSessionSummaryPaneKey', () => {
  it('returns null without an active worktree', () => {
    expect(selectSessionSummaryPaneKey(makeState(), null)).toBeNull()
  })

  it('follows the focused agent pane over a newer one in the same workspace', () => {
    const state = makeState({
      agentStatusByPaneKey: {
        [PANE_KEY]: makeAgentStatusEntry(PANE_KEY, 1_000),
        [OTHER_PANE_KEY]: makeAgentStatusEntry(OTHER_PANE_KEY, 9_000)
      }
    })

    expect(selectSessionSummaryPaneKey(state, WORKTREE_ID)).toBe(PANE_KEY)
  })

  // The hook server keeps a provider-session remnant for a dropped status row, so a
  // hibernated pane the user focused is still summarizable.
  it('follows a focused hibernated pane', () => {
    const state = makeState({
      retainedAgentsByPaneKey: { [PANE_KEY]: makeRetainedEntry(PANE_KEY) }
    })

    expect(selectSessionSummaryPaneKey(state, WORKTREE_ID)).toBe(PANE_KEY)
  })

  it('returns null when the focused pane is not an agent', () => {
    const editorFocused = makeState({ activeTabType: 'editor' })
    expect(selectSessionSummaryPaneKey(editorFocused, WORKTREE_ID)).toBeNull()

    // A plain terminal leaf with no status row and no retained entry.
    const plainTerminal = makeState({ activeTabId: TAB_ID })
    expect(selectSessionSummaryPaneKey(plainTerminal, WORKTREE_ID)).toBeNull()
  })

  it('returns null when nothing is focused', () => {
    expect(selectSessionSummaryPaneKey(makeState({ activeTabId: null }), WORKTREE_ID)).toBeNull()
  })

  it('returns null when the focused pane belongs to another worktree', () => {
    const state = makeState({
      activeWorktreeId: OTHER_WORKTREE_ID,
      activeTabId: OTHER_TAB_ID,
      terminalLayoutsByTabId: {
        [OTHER_TAB_ID]: {
          root: { type: 'leaf', leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          expandedLeafId: null
        }
      },
      agentStatusByPaneKey: { [PANE_KEY]: makeAgentStatusEntry(PANE_KEY, 9_000) }
    })

    expect(selectSessionSummaryPaneKey(state, OTHER_WORKTREE_ID)).toBeNull()
  })
})
