import { describe, expect, it } from 'vitest'
import type { TerminalLayoutSnapshot } from '../../../shared/workspace-layout/terminal-tab-types'
import { getWorktreeStatus, resolveWorktreeStatus } from './worktree-status'

const LEAF_ID_1 = '11111111-1111-4111-8111-111111111111'
const LEAF_ID_2 = '22222222-2222-4222-8222-222222222222'

// Tests declare live tab IDs; tab.ptyId survives sleep as a wake hint and must not imply liveness.
function livePtyMap(...tabIds: string[]): Record<string, string[]> {
  return Object.fromEntries(tabIds.map((id, i) => [id, [`pty-${i}`]]))
}

function splitLayout(): TerminalLayoutSnapshot {
  return {
    root: {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: LEAF_ID_1 },
      second: { type: 'leaf', leafId: LEAF_ID_2 }
    },
    activeLeafId: LEAF_ID_1,
    expandedLeafId: null
  }
}

describe('getWorktreeStatus', () => {
  it('ignores a leftover permission title for an agent that has an unplaced working row', () => {
    // Why: a mirrored pane re-keyed on restore keeps the `π !` marker it was launched with,
    // while its explicit row still reports working for this worktree under the old pane key.
    // The title alone must not pin the card to permission.
    const status = getWorktreeStatus(
      [{ id: 'tab-1', title: 'π ! main - orca' }],
      [],
      livePtyMap('tab-1'),
      { 'tab-1': { 0: 'π ! main - orca' } },
      { permissionYieldingAgentTypes: new Set(['pi']) }
    )

    // The title stopped claiming a question; the row that reports the work still supplies
    // `working` to the card (see the resolveWorktreeStatus case below).
    expect(status).toBe('active')
  })

  it('still reports permission when another agent type owns the unplaced row', () => {
    // Why: yielding is per agent type; one agent running says nothing about another that waits.
    const status = getWorktreeStatus(
      [{ id: 'tab-1', title: 'π ! main - orca' }],
      [],
      livePtyMap('tab-1'),
      { 'tab-1': { 0: 'π ! main - orca' } },
      { permissionYieldingAgentTypes: new Set(['claude']) }
    )

    expect(status).toBe('permission')
  })

  it('still reports permission while the worktree agent is monitoring', () => {
    // Why: only a working row contradicts a wait; a monitoring row says nothing about
    // whether some other pane is blocked on the user.
    const status = getWorktreeStatus(
      [{ id: 'tab-1', title: 'π ! main - orca' }],
      [],
      livePtyMap('tab-1'),
      { 'tab-1': { 0: 'π ! main - orca' } },
      { liveAgentStatus: 'monitoring' }
    )

    expect(status).toBe('permission')
  })
})

describe('resolveWorktreeStatus', () => {
  it('keeps a re-keyed pane working instead of pinning its card to permission', () => {
    // Why: this is the card path. The leftover `π !` marker must not outrank the fresh working
    // row the agent still reports under the tab this renderer lost.
    const status = resolveWorktreeStatus({
      tabs: [{ id: 'tab-1', title: 'π ! main - orca' }],
      browserTabs: [],
      ptyIdsByTabId: livePtyMap('tab-1'),
      runtimePaneTitlesByTabId: { 'tab-1': { 0: 'π ! main - orca' } },
      permissionYieldingAgentTypes: new Set(['pi']),
      hasPermission: false,
      hasLiveWorking: true,
      hasLiveDone: false,
      hasRetainedDone: false
    })

    expect(status).toBe('working')
  })

  it('keeps permission when another agent type owns the unplaced working row', () => {
    // Why: one agent running must not hide a second agent's question.
    const status = resolveWorktreeStatus({
      tabs: [{ id: 'tab-1', title: 'π ! main - orca' }],
      browserTabs: [],
      ptyIdsByTabId: livePtyMap('tab-1'),
      runtimePaneTitlesByTabId: { 'tab-1': { 0: 'π ! main - orca' } },
      permissionYieldingAgentTypes: new Set(['claude']),
      hasPermission: false,
      hasLiveWorking: true,
      hasLiveDone: false,
      hasRetainedDone: false
    })

    expect(status).toBe('permission')
  })

  it('reports setup while the repo setup script runs, above the passive states', () => {
    const base = {
      tabs: [{ id: 'tab-1', title: 'bash' }],
      browserTabs: [],
      ptyIdsByTabId: livePtyMap('tab-1'),
      hasPermission: false,
      hasLiveWorking: false,
      hasLiveDone: false,
      hasRetainedDone: false
    }

    // Why: the setup runner is the worktree's only live PTY and reports no
    // agent status, so without this it would read as plain 'active'.
    expect(resolveWorktreeStatus({ ...base, setupRunning: true })).toBe('setup')
    expect(resolveWorktreeStatus({ ...base, setupRunning: true, hasLiveDone: true })).toBe('setup')
    expect(resolveWorktreeStatus({ ...base, setupRunning: true, hasInterrupted: true })).toBe(
      'setup'
    )
    expect(resolveWorktreeStatus({ ...base, setupRunning: false })).toBe('active')
  })

  it('lets a real agent state outrank setup', () => {
    const base = {
      tabs: [{ id: 'tab-1', title: 'bash' }],
      browserTabs: [],
      ptyIdsByTabId: livePtyMap('tab-1'),
      hasLiveDone: false,
      hasRetainedDone: false,
      setupRunning: true
    }

    expect(resolveWorktreeStatus({ ...base, hasPermission: true, hasLiveWorking: true })).toBe(
      'permission'
    )
    expect(resolveWorktreeStatus({ ...base, hasPermission: false, hasLiveWorking: true })).toBe(
      'working'
    )
    expect(
      resolveWorktreeStatus({
        ...base,
        hasPermission: false,
        hasLiveWorking: false,
        hasLiveMonitoring: true
      })
    ).toBe('monitoring')
  })

  it('lets a hook-covered done pane suppress its stale working title', () => {
    const status = resolveWorktreeStatus({
      tabs: [{ id: 'tab-1', title: 'claude [working]' }],
      browserTabs: [],
      ptyIdsByTabId: livePtyMap('tab-1'),
      runtimePaneTitlesByTabId: {
        'tab-1': {
          1: 'codex [working]',
          2: 'bash'
        }
      },
      agentStatusPaneIdsByTabId: {
        'tab-1': new Set([LEAF_ID_1])
      },
      terminalLayoutsByTabId: {
        'tab-1': splitLayout()
      },
      hasPermission: false,
      hasLiveWorking: false,
      hasLiveDone: true,
      hasRetainedDone: false
    })

    expect(status).toBe('done')
  })

  it('keeps sibling pane working when hook done covers only another pane', () => {
    const status = resolveWorktreeStatus({
      tabs: [{ id: 'tab-1', title: 'claude [working]' }],
      browserTabs: [],
      ptyIdsByTabId: livePtyMap('tab-1'),
      runtimePaneTitlesByTabId: {
        'tab-1': {
          1: 'bash',
          2: 'codex [working]'
        }
      },
      agentStatusPaneIdsByTabId: {
        'tab-1': new Set([LEAF_ID_1])
      },
      terminalLayoutsByTabId: {
        'tab-1': splitLayout()
      },
      hasPermission: false,
      hasLiveWorking: false,
      hasLiveDone: true,
      hasRetainedDone: false
    })

    expect(status).toBe('working')
  })
})
