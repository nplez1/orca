import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { TerminalTab } from '../../../../shared/workspace-layout/terminal-tab-types'
import { toWebTerminalSurfaceTabId } from '../../../../shared/workspace-layout/terminal-surface-id'
import {
  resetUnreadAgentCompletionTabIdsCacheForTest,
  resetTerminalTabActivityFlagsCacheForTest,
  resolveTerminalTabActivityStatus
} from './terminal-tab-activity-status'

const TAB_ID = 'tab-1'
const FIRST_LEAF_ID = '11111111-1111-4111-8111-111111111111'

const NOW = 10_000

const TAB: Pick<TerminalTab, 'id' | 'title'> = { id: TAB_ID, title: 'Codex' }

function entry(
  leafId: string,
  state: AgentStatusEntry['state'],
  overrides: Partial<AgentStatusEntry> = {}
): AgentStatusEntry {
  const paneKey = `${TAB_ID}:${leafId}`
  return {
    paneKey,
    state,
    prompt: '',
    updatedAt: NOW,
    stateStartedAt: NOW,
    stateHistory: [],
    agentType: 'codex',
    ...overrides
  }
}

/** One live PTY for the tab so title/liveness gates pass. */
const LIVE_PTY = { [TAB_ID]: ['pty-1'] }

beforeEach(() => {
  resetTerminalTabActivityFlagsCacheForTest()
  resetUnreadAgentCompletionTabIdsCacheForTest()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
  resetTerminalTabActivityFlagsCacheForTest()
  resetUnreadAgentCompletionTabIdsCacheForTest()
})

describe('resolveTerminalTabActivityStatus', () => {
  // A local pane always has per-pane titles, so this is the path a live title actually takes: an
  // old `done` row must not quiet it.
  it('keeps a live working title on a local pane whose only row is an old finish', () => {
    const stale = entry(FIRST_LEAF_ID, 'done', { updatedAt: 0 })
    vi.setSystemTime(31 * 60 * 1000)
    expect(
      resolveTerminalTabActivityStatus({
        tab: { id: TAB_ID, title: 'Codex working' },
        agentStatusByPaneKey: { [stale.paneKey]: stale },
        runtimePaneTitlesByTabId: { [TAB_ID]: { 1: 'Codex working' } },
        ptyIdsByTabId: LIVE_PTY
      })
    ).toBe('working')
  })

  // The reported remote shape: a paired host's last working title sits cached in
  // runtimePaneTitlesByTabId with no age of its own, so a row that recorded a finish has to quiet
  // it — otherwise the tab spun until the app restarted.
  it('quietens the cached working title of a mirrored pane whose row records a finish', () => {
    const mirroredTabId = toWebTerminalSurfaceTabId('host-tab-1')
    const stale = entry(FIRST_LEAF_ID, 'done', {
      updatedAt: 0,
      paneKey: `${mirroredTabId}:${FIRST_LEAF_ID}`
    })
    vi.setSystemTime(31 * 60 * 1000)
    expect(
      resolveTerminalTabActivityStatus({
        tab: { id: mirroredTabId, title: 'π - widget' },
        agentStatusByPaneKey: { [stale.paneKey]: stale },
        runtimePaneTitlesByTabId: { [mirroredTabId]: { 1: '⠋ π - widget' } },
        ptyIdsByTabId: { [mirroredTabId]: ['pty-1'] }
      })
    ).toBe('active')
  })
  it('de-spins a stale working tab on an epoch bump without a new map reference', () => {
    // Freshness epochs can stale a row without replacing its map; invalidate cached flags so abandoned tabs stop spinning.
    const working = entry(FIRST_LEAF_ID, 'working')
    const agentStatusByPaneKey = { [working.paneKey]: working }
    expect(
      resolveTerminalTabActivityStatus({
        tab: TAB,
        agentStatusByPaneKey,
        agentStatusEpoch: 0,
        ptyIdsByTabId: LIVE_PTY
      })
    ).toBe('working')

    vi.setSystemTime(31 * 60 * 1000)
    expect(
      resolveTerminalTabActivityStatus({
        tab: TAB,
        agentStatusByPaneKey,
        agentStatusEpoch: 1,
        ptyIdsByTabId: LIVE_PTY
      })
    ).toBe('active')
  })
})
