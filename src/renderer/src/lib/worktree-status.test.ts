import { describe, expect, it } from 'vitest'
import type { TerminalLayoutSnapshot } from '../../../shared/terminal-tab-types'
import { getWorktreeStatus, getWorktreeStatusLabel, resolveWorktreeStatus } from './worktree-status'

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
  it('prioritizes permission over other live activity states', () => {
    const status = getWorktreeStatus(
      [
        { id: 'tab-1', title: 'claude [working]' },
        { id: 'tab-2', title: 'claude [permission]' }
      ],
      [{ id: 'browser-1' }],
      livePtyMap('tab-1', 'tab-2')
    )

    expect(status).toBe('permission')
    expect(getWorktreeStatusLabel(status)).toBe('Needs permission')
  })

  it('treats browser-only worktrees as active', () => {
    const status = getWorktreeStatus([], [{ id: 'browser-1' }], {})

    expect(status).toBe('active')
  })

  it('preserves a working agent status without a renderer PTY', () => {
    const status = getWorktreeStatus([], [], {}, {}, { liveAgentStatus: 'working' })

    expect(status).toBe('working')
  })

  it('preserves a permission agent status without a renderer PTY', () => {
    const status = getWorktreeStatus([], [], {}, {}, { liveAgentStatus: 'permission' })

    expect(status).toBe('permission')
  })

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

  it('returns inactive when neither tabs nor browser state are live', () => {
    expect(getWorktreeStatus([], [], {})).toBe('inactive')
  })

  it('reports working when any pane in a split-pane tab is working even if tab.title is idle', () => {
    // Focused-pane changes rewrite tab.title; idle focus must not hide another working pane’s spinner.
    const status = getWorktreeStatus(
      [{ id: 'tab-1', title: 'claude [done]' }],
      [],
      livePtyMap('tab-1'),
      { 'tab-1': { 0: 'codex [working]', 1: 'claude [done]' } }
    )

    expect(status).toBe('working')
  })

  it('prefers pane-level permission status over tab.title', () => {
    const status = getWorktreeStatus(
      [{ id: 'tab-1', title: 'claude [done]' }],
      [],
      livePtyMap('tab-1'),
      { 'tab-1': { 0: 'claude [permission]', 1: 'claude [done]' } }
    )

    expect(status).toBe('permission')
  })

  // Sleep clears live ptyIdsByTabId but retains tab.ptyId as a wake hint; only the former proves liveness.
  it('returns inactive for a slept tab (ptyIdsByTabId empty even if heuristic title matches working)', () => {
    const status = getWorktreeStatus([{ id: 'tab-1', title: 'claude [working]' }], [], {
      'tab-1': []
    })

    expect(status).toBe('inactive')
  })

  it('returns active when ptyIdsByTabId has entries (live precondition)', () => {
    const status = getWorktreeStatus([{ id: 'tab-1', title: 'bash' }], [], livePtyMap('tab-1'))

    expect(status).toBe('active')
  })

  // Exited agents can leave frozen spinner titles. Without attributable Claude identity the row builder shows no agent; the dot must agree.
  it('does not spin on a bare braille-spinner tab title that yields no agent row', () => {
    const status = getWorktreeStatus(
      [{ id: 'tab-1', title: '⠐ Review branch for regressions' }],
      [],
      livePtyMap('tab-1')
    )

    expect(status).toBe('active')
  })

  it('does not spin on a bare braille-spinner pane title that yields no agent row', () => {
    const status = getWorktreeStatus([{ id: 'tab-1', title: 'bash' }], [], livePtyMap('tab-1'), {
      'tab-1': { 0: '⠐ Review branch for regressions', 1: 'bash' }
    })

    expect(status).toBe('active')
  })

  it('still spins on an agent-attributable braille-spinner title', () => {
    const status = getWorktreeStatus(
      [{ id: 'tab-1', title: '⠹ codex fix flaky test' }],
      [],
      livePtyMap('tab-1')
    )

    expect(status).toBe('working')
  })
})

describe('resolveWorktreeStatus', () => {
  it('returns inactive when no tab has a live pty and no explicit agent row exists', () => {
    const status = resolveWorktreeStatus({
      tabs: [{ id: 'tab-1', title: 'claude [done]' }],
      browserTabs: [],
      // Slept: live-pty array empty; tab.ptyId would be the wake-hint sessionId.
      ptyIdsByTabId: { 'tab-1': [] },
      hasPermission: false,
      hasLiveWorking: false,
      hasLiveDone: false,
      hasRetainedDone: false
    })

    expect(status).toBe('inactive')
  })

  it('promotes to done when a retained done row is visible, even without a live pty', () => {
    const status = resolveWorktreeStatus({
      tabs: [{ id: 'tab-1', title: 'bash' }],
      browserTabs: [],
      ptyIdsByTabId: { 'tab-1': [] },
      hasPermission: false,
      hasLiveWorking: false,
      hasLiveDone: false,
      hasRetainedDone: true
    })

    expect(status).toBe('done')
  })

  it('treats pending paired web host terminal mirrors as inactive without a live pty', () => {
    const status = resolveWorktreeStatus({
      tabs: [{ id: 'web-terminal-host-tab-1', title: 'Terminal 1' }],
      browserTabs: [],
      ptyIdsByTabId: {},
      hasPermission: false,
      hasLiveWorking: false,
      hasLiveDone: false,
      hasRetainedDone: false
    })

    expect(status).toBe('inactive')
  })

  it('treats ready paired web host terminal mirrors as active once they have a live pty', () => {
    const status = resolveWorktreeStatus({
      tabs: [{ id: 'web-terminal-host-tab-1', title: 'Terminal 1' }],
      browserTabs: [],
      ptyIdsByTabId: { 'web-terminal-host-tab-1': ['pty-1'] },
      hasPermission: false,
      hasLiveWorking: false,
      hasLiveDone: false,
      hasRetainedDone: false
    })

    expect(status).toBe('active')
  })

  it('keeps browser-only paired workspaces active without terminal liveness', () => {
    const status = resolveWorktreeStatus({
      tabs: [{ id: 'web-terminal-host-tab-1', title: 'Terminal 1' }],
      browserTabs: [{ id: 'browser-1' }],
      ptyIdsByTabId: {},
      hasPermission: false,
      hasLiveWorking: false,
      hasLiveDone: false,
      hasRetainedDone: false
    })

    expect(status).toBe('active')
  })

  it('promotes to permission when an explicit agent row needs input, even without a live pty', () => {
    const status = resolveWorktreeStatus({
      tabs: [{ id: 'tab-1', title: 'claude [permission]' }],
      browserTabs: [],
      ptyIdsByTabId: { 'tab-1': [] },
      hasPermission: true,
      hasLiveWorking: false,
      hasLiveDone: false,
      hasRetainedDone: false
    })

    expect(status).toBe('permission')
  })

  it('promotes to permission when live and hasPermission', () => {
    const status = resolveWorktreeStatus({
      tabs: [{ id: 'tab-1', title: 'bash' }],
      browserTabs: [],
      ptyIdsByTabId: livePtyMap('tab-1'),
      hasPermission: true,
      hasLiveWorking: false,
      hasLiveDone: false,
      hasRetainedDone: false
    })

    expect(status).toBe('permission')
  })

  it('promotes to working from a fresh explicit agent row before pane titles restore', () => {
    const status = resolveWorktreeStatus({
      tabs: [{ id: 'tab-1', title: 'bash' }],
      browserTabs: [],
      ptyIdsByTabId: livePtyMap('tab-1'),
      hasPermission: false,
      hasLiveWorking: true,
      hasLiveDone: false,
      hasRetainedDone: false
    })

    expect(status).toBe('working')
  })

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

  it('reports passive monitoring below active work and permission', () => {
    const base = {
      tabs: [{ id: 'tab-1', title: 'bash' }],
      browserTabs: [],
      ptyIdsByTabId: livePtyMap('tab-1'),
      hasLiveDone: false,
      hasRetainedDone: false
    }

    expect(
      resolveWorktreeStatus({
        ...base,
        hasPermission: false,
        hasLiveWorking: false,
        hasLiveMonitoring: true
      })
    ).toBe('monitoring')
    expect(
      resolveWorktreeStatus({
        ...base,
        hasPermission: false,
        hasLiveWorking: true,
        hasLiveMonitoring: true
      })
    ).toBe('working')
    expect(
      resolveWorktreeStatus({
        ...base,
        hasPermission: true,
        hasLiveWorking: true,
        hasLiveMonitoring: true
      })
    ).toBe('permission')
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

  it('lets heuristic working beat hasLiveDone (newer in-progress signal wins)', () => {
    const status = resolveWorktreeStatus({
      tabs: [{ id: 'tab-1', title: 'claude [working]' }],
      browserTabs: [],
      ptyIdsByTabId: livePtyMap('tab-1'),
      hasPermission: false,
      hasLiveWorking: false,
      hasLiveDone: true,
      hasRetainedDone: false
    })

    expect(status).toBe('working')
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

  it('lets a single hook-covered done pane suppress an unmapped single working title', () => {
    const status = resolveWorktreeStatus({
      tabs: [{ id: 'tab-1', title: 'claude [working]' }],
      browserTabs: [],
      ptyIdsByTabId: livePtyMap('tab-1'),
      runtimePaneTitlesByTabId: {
        'tab-1': {
          1: 'codex [working]'
        }
      },
      agentStatusPaneIdsByTabId: {
        'tab-1': new Set([LEAF_ID_1])
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

  // Permission outranks working/done for both explicit hooks and title heuristics; done overlays must not suppress a scraped permission question.
  it('honors heuristic permission over hasLiveDone (priority: permission > done)', () => {
    const status = resolveWorktreeStatus({
      tabs: [{ id: 'tab-1', title: 'claude [permission]' }],
      browserTabs: [],
      ptyIdsByTabId: livePtyMap('tab-1'),
      hasPermission: false,
      hasLiveWorking: false,
      hasLiveDone: true,
      hasRetainedDone: false
    })

    expect(status).toBe('permission')
  })

  it('promotes to done when live and hasRetainedDone (no working heuristic)', () => {
    const status = resolveWorktreeStatus({
      tabs: [{ id: 'tab-1', title: 'bash' }],
      browserTabs: [],
      ptyIdsByTabId: livePtyMap('tab-1'),
      hasPermission: false,
      hasLiveWorking: false,
      hasLiveDone: false,
      hasRetainedDone: true
    })

    expect(status).toBe('done')
  })

  it('keeps a hook-backed working agent spinning despite an unattributable stale title', () => {
    // Hook-managed working rows must survive the title-attribution gate.
    const status = resolveWorktreeStatus({
      tabs: [{ id: 'tab-1', title: '⠐ Review branch for regressions' }],
      browserTabs: [],
      ptyIdsByTabId: livePtyMap('tab-1'),
      hasPermission: false,
      hasLiveWorking: true,
      hasLiveDone: false,
      hasRetainedDone: false
    })

    expect(status).toBe('working')
  })

  it('resolves a stale unattributable spinner title with no hook entry to active, not working', () => {
    const status = resolveWorktreeStatus({
      tabs: [{ id: 'tab-1', title: '⠐ Review branch for regressions' }],
      browserTabs: [],
      ptyIdsByTabId: livePtyMap('tab-1'),
      hasPermission: false,
      hasLiveWorking: false,
      hasLiveDone: false,
      hasRetainedDone: false
    })

    expect(status).toBe('active')
  })

  it('falls through to active heuristic when nothing else applies', () => {
    const status = resolveWorktreeStatus({
      tabs: [{ id: 'tab-1', title: 'bash' }],
      browserTabs: [],
      ptyIdsByTabId: livePtyMap('tab-1'),
      hasPermission: false,
      hasLiveWorking: false,
      hasLiveDone: false,
      hasRetainedDone: false
    })

    expect(status).toBe('active')
  })
})
