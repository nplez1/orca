import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetAgentStatusEpochClockForTests } from '@/lib/agent-status-epoch-clock'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import type { Tab } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import {
  useIsSleepingWorktree,
  resetWorktreeSleepStateCacheForTests
} from './use-worktree-sleep-state'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'

type MockState = {
  activeWorktreeId?: string | null
  tabsByWorktree: Record<string, TerminalTab[]>
  closedTerminalTabTombstonesByTabId: Record<string, { closedAt: number; worktreeId: string }>
  browserTabsByWorktree: Record<string, { id: string }[]>
  unifiedTabsByWorktree: Record<string, Tab[]>
  structuredChatSleptAtByPaneKey: Record<string, number>
  ptyIdsByTabId: Record<string, string[]>
  agentStatusEpoch: number
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
  runtimeAgentOrchestrationByPaneKey: Record<string, NonNullable<AgentStatusEntry['orchestration']>>
  migrationUnsupportedByPtyId: Record<string, never>
  retainedAgentsByPaneKey: Record<string, unknown>
}

let mockState: MockState

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: MockState) => unknown) => selector(mockState)
}))

function makeTab(id: string, worktreeId: string): TerminalTab {
  return {
    id,
    worktreeId,
    ptyId: 'pty-1',
    title: 'bash',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function makeAgentStatusEntry(args: {
  paneKey: string
  state: AgentStatusEntry['state']
  worktreeId?: string
}): AgentStatusEntry {
  return {
    paneKey: args.paneKey,
    state: args.state,
    prompt: '',
    updatedAt: 1_000,
    stateStartedAt: 1_000,
    stateHistory: [],
    worktreeId: args.worktreeId,
    orchestration: undefined
  }
}

function makeUnifiedTab(args: {
  id: string
  worktreeId: string
  contentType: Tab['contentType']
  agentSessionAgent?: Tab['agentSessionAgent']
}): Tab {
  return {
    id: args.id,
    entityId: `entity-${args.id}`,
    groupId: 'group-1',
    worktreeId: args.worktreeId,
    contentType: args.contentType,
    label: args.id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...(args.agentSessionAgent ? { agentSessionAgent: args.agentSessionAgent } : {})
  }
}

function SleepProbe({ worktreeId }: { worktreeId: string }) {
  return <span>{String(useIsSleepingWorktree(worktreeId))}</span>
}

describe('useIsSleepingWorktree', () => {
  beforeEach(() => {
    resetWorktreeSleepStateCacheForTests()
    // Reset epoch-clock samples so tests using epoch zero do not inherit prior timestamps.
    resetAgentStatusEpochClockForTests()
    vi.spyOn(Date, 'now').mockReturnValue(2_000)
    mockState = {
      tabsByWorktree: {},
      closedTerminalTabTombstonesByTabId: {},
      browserTabsByWorktree: {},
      unifiedTabsByWorktree: {},
      structuredChatSleptAtByPaneKey: {},
      ptyIdsByTabId: {},
      agentStatusEpoch: 0,
      agentStatusByPaneKey: {},
      runtimeAgentOrchestrationByPaneKey: {},
      migrationUnsupportedByPtyId: {},
      retainedAgentsByPaneKey: {}
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('treats a worktree with no tabs or agents as sleeping', () => {
    expect(renderToStaticMarkup(<SleepProbe worktreeId="repo1::/path/wt1" />)).toBe(
      '<span>true</span>'
    )
  })

  it('treats a worktree whose only surface is a structured chat as awake', () => {
    const worktreeId = 'repo1::/path/wt1'
    mockState = {
      ...mockState,
      unifiedTabsByWorktree: {
        [worktreeId]: [
          makeUnifiedTab({
            id: 'chat-1',
            worktreeId,
            contentType: 'agent-session',
            agentSessionAgent: 'claude'
          })
        ]
      }
    }

    expect(renderToStaticMarkup(<SleepProbe worktreeId={worktreeId} />)).toBe('<span>false</span>')
  })

  it('keeps a structured chat awake once its turn has finished', () => {
    // A completed structured chat has no fresh non-done agent; the chat itself must keep its workspace awake.
    const worktreeId = 'repo1::/path/wt1'
    const paneKey = makePaneKey('chat-1', LEAF_ID)
    mockState = {
      ...mockState,
      unifiedTabsByWorktree: {
        [worktreeId]: [
          makeUnifiedTab({
            id: 'chat-1',
            worktreeId,
            contentType: 'agent-session',
            agentSessionAgent: 'codex'
          })
        ]
      },
      agentStatusByPaneKey: {
        [paneKey]: makeAgentStatusEntry({ paneKey, state: 'done', worktreeId })
      }
    }

    expect(renderToStaticMarkup(<SleepProbe worktreeId={worktreeId} />)).toBe('<span>false</span>')
  })

  it('does not treat a non-chat unified tab as activity', () => {
    const worktreeId = 'repo1::/path/wt1'
    mockState = {
      ...mockState,
      unifiedTabsByWorktree: {
        [worktreeId]: [makeUnifiedTab({ id: 'file-1', worktreeId, contentType: 'editor' })]
      }
    }

    expect(renderToStaticMarkup(<SleepProbe worktreeId={worktreeId} />)).toBe('<span>true</span>')
  })

  it('does not treat a structured chat as activity for a different worktree', () => {
    const worktreeId = 'repo1::/path/wt1'
    mockState = {
      ...mockState,
      unifiedTabsByWorktree: {
        'repo1::/path/wt2': [
          makeUnifiedTab({
            id: 'chat-1',
            worktreeId: 'repo1::/path/wt2',
            contentType: 'agent-session',
            agentSessionAgent: 'claude'
          })
        ]
      }
    }

    expect(renderToStaticMarkup(<SleepProbe worktreeId={worktreeId} />)).toBe('<span>true</span>')
  })

  it('treats a worktree with a live PTY as awake', () => {
    const worktreeId = 'repo1::/path/wt1'
    mockState = {
      ...mockState,
      tabsByWorktree: { [worktreeId]: [makeTab('tab-1', worktreeId)] },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] }
    }

    expect(renderToStaticMarkup(<SleepProbe worktreeId={worktreeId} />)).toBe('<span>false</span>')
  })

  it('treats a worktree with only a dead tab as sleeping', () => {
    const worktreeId = 'repo1::/path/wt1'
    mockState = {
      ...mockState,
      tabsByWorktree: { [worktreeId]: [makeTab('tab-1', worktreeId)] },
      ptyIdsByTabId: {}
    }

    expect(renderToStaticMarkup(<SleepProbe worktreeId={worktreeId} />)).toBe('<span>true</span>')
  })

  // Why: an emptied workspace has no surfaces by design, so it is awake with its empty-tabs surface
  // on screen — only the close record tells it apart from one that was never initialized (#96).
  it('treats a workspace whose last tab was closed as awake', () => {
    const worktreeId = 'repo1::/path/wt1'
    mockState = {
      ...mockState,
      tabsByWorktree: { [worktreeId]: [] },
      closedTerminalTabTombstonesByTabId: { closed: { closedAt: 1_000, worktreeId } }
    }

    expect(renderToStaticMarkup(<SleepProbe worktreeId={worktreeId} />)).toBe('<span>false</span>')
  })

  it('still treats an empty row with no close record as sleeping', () => {
    const worktreeId = 'repo1::/path/wt1'
    mockState = {
      ...mockState,
      tabsByWorktree: { [worktreeId]: [] }
    }

    expect(renderToStaticMarkup(<SleepProbe worktreeId={worktreeId} />)).toBe('<span>true</span>')
  })

  it('keeps a slept structured chat asleep even when a terminal was closed here', () => {
    // Regression: the close record alone used to make any workspace with no terminals read awake,
    // so sleeping a chat workspace silently removed it from the glyph, the filter and the reveal.
    const worktreeId = 'repo1::/path/wt1'
    const chatTab = makeUnifiedTab({
      id: 'chat-1',
      worktreeId,
      contentType: 'agent-session',
      agentSessionAgent: 'codex'
    })
    const paneKey = structuredAgentSessionPaneKey(chatTab.id, chatTab.entityId)
    mockState = {
      ...mockState,
      tabsByWorktree: { [worktreeId]: [] },
      closedTerminalTabTombstonesByTabId: { closed: { closedAt: 1_000, worktreeId } },
      unifiedTabsByWorktree: { [worktreeId]: [chatTab] },
      structuredChatSleptAtByPaneKey: { [paneKey]: 1_500 }
    }

    expect(renderToStaticMarkup(<SleepProbe worktreeId={worktreeId} />)).toBe('<span>true</span>')
  })

  it('keeps the workspace on screen awake when it has nothing left to render', () => {
    // A workspace the user is looking at with no tabs is its empty-tabs state, whatever emptied it
    // — the chat, browser and editor closes that write no terminal close record included (#96).
    const worktreeId = 'repo1::/path/wt1'
    mockState = {
      ...mockState,
      activeWorktreeId: worktreeId,
      tabsByWorktree: { [worktreeId]: [] }
    }

    expect(renderToStaticMarkup(<SleepProbe worktreeId={worktreeId} />)).toBe('<span>false</span>')
  })

  it('stops treating the workspace as awake once its close record expires', () => {
    const worktreeId = 'repo1::/path/wt1'
    mockState = {
      ...mockState,
      tabsByWorktree: { [worktreeId]: [] },
      closedTerminalTabTombstonesByTabId: {
        closed: { closedAt: 2_000 - 31 * 24 * 60 * 60 * 1000, worktreeId }
      }
    }

    expect(renderToStaticMarkup(<SleepProbe worktreeId={worktreeId} />)).toBe('<span>true</span>')
  })

  it('treats a browser tab as awake', () => {
    const worktreeId = 'repo1::/path/wt1'
    mockState = {
      ...mockState,
      browserTabsByWorktree: { [worktreeId]: [{ id: 'browser-1' }] }
    }

    expect(renderToStaticMarkup(<SleepProbe worktreeId={worktreeId} />)).toBe('<span>false</span>')
  })

  it('treats retained done rows without runtime as sleeping (#19624)', () => {
    const worktreeId = 'repo1::/path/wt1'
    const tab = makeTab('tab-1', worktreeId)
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    mockState = {
      ...mockState,
      retainedAgentsByPaneKey: {
        [paneKey]: {
          entry: makeAgentStatusEntry({ paneKey, state: 'done' }),
          worktreeId,
          tab,
          agentType: 'codex',
          startedAt: 1_000
        }
      }
    }

    expect(renderToStaticMarkup(<SleepProbe worktreeId={worktreeId} />)).toBe('<span>true</span>')
  })

  it('keeps a fresh working agent awake through a PTY gap', () => {
    const worktreeId = 'repo1::/path/wt1'
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    mockState = {
      ...mockState,
      agentStatusByPaneKey: {
        [paneKey]: makeAgentStatusEntry({ paneKey, state: 'working', worktreeId })
      }
    }

    expect(renderToStaticMarkup(<SleepProbe worktreeId={worktreeId} />)).toBe('<span>false</span>')
  })

  it('agrees with the hide-sleeping filter on a stale agent row', () => {
    const worktreeId = 'repo1::/path/wt1'
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    const entry = makeAgentStatusEntry({ paneKey, state: 'working', worktreeId })
    vi.spyOn(Date, 'now').mockReturnValue(9_000_000)
    resetAgentStatusEpochClockForTests()
    mockState = {
      ...mockState,
      // The sleeping glyph must use the filter’s shared agent-freshness boundary.
      agentStatusByPaneKey: { [paneKey]: { ...entry, updatedAt: 0 } },
      agentStatusEpoch: 1
    }

    expect(renderToStaticMarkup(<SleepProbe worktreeId={worktreeId} />)).toBe('<span>true</span>')
  })
})
