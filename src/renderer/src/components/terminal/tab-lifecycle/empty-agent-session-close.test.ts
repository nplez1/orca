import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { PtyRunningWorkProbe } from '../../../../../shared/terminal/pty/lifecycle/pty-running-work-probe'

// A wrong "nothing to stop" silently kills a real agent, so only the launched process itself may close unasked (#95).

const probePtyRunningWork = vi.fn<(ptyIds: readonly string[]) => Promise<PtyRunningWorkProbe[]>>()
vi.mock('./pty-running-work-probe', () => ({ probePtyRunningWork }))

const { createTestStore } = await import('@/store/testing/app-store-test-fixture')
const store = createTestStore()
vi.mock('@/store', () => ({ useAppStore: store }))

const { acceptedAgentStatuses } =
  await import('@/store/slices/agent-status/status-ownership/accepted-agent-statuses')
const { guardRunningTerminalClose } = await import('./running-terminal-close-guard')
const { isProbeOfEmptyAgentSession } = await import('./terminal-close-copy-kind')
const { useRunningTerminalCloseConfirmStore } =
  await import('@/store/slices/tabs/closing/running-terminal-close-confirm')
const {
  bindPromptFreeAgentTabLaunch,
  forgetPromptFreeAgentTabLaunch,
  isPromptFreeAgentTabLaunch,
  notePromptFreeAgentTabLaunch
} = await import('@/lib/agent-session/launch/new-tab/agent-tab-prompt-free-launch')

const TAB = 'tab-1'
const LEAF = '00000000-0000-4000-8000-000000000001'
const OTHER_LEAF = '00000000-0000-4000-8000-000000000002'
const PTY = 'pty-launched'

function seedEmptyAgentPane(ptyId: string): void {
  const entry: AgentStatusEntry = {
    state: 'done',
    sessionBoundary: true,
    prompt: '',
    updatedAt: 1_000,
    stateStartedAt: 1_000,
    agentType: 'claude',
    paneKey: `${TAB}:${LEAF}`,
    stateHistory: []
  }
  store.setState({
    ptyIdsByTabId: { [TAB]: [ptyId] },
    terminalLayoutsByTabId: {
      [TAB]: {
        root: { type: 'leaf', leafId: LEAF },
        activeLeafId: LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF]: ptyId }
      }
    },
    agentStatusByPaneKey: acceptedAgentStatuses([[entry.paneKey, entry]]),
    lastTerminalInputAtByPaneKey: {}
  })
}

function probe(verdict: PtyRunningWorkProbe['verdict'], timedOut = false): PtyRunningWorkProbe {
  return { ptyId: PTY, verdict, timedOut, remote: false }
}

async function closeTab(): Promise<'closed' | 'asked'> {
  const onClose = vi.fn()
  guardRunningTerminalClose({ terminalTabId: TAB, onClose })
  await vi.waitFor(() => {
    expect(
      onClose.mock.calls.length > 0 ||
        useRunningTerminalCloseConfirmStore.getState().runningTerminalCloseConfirm !== null
    ).toBe(true)
  })
  return onClose.mock.calls.length > 0 ? 'closed' : 'asked'
}

beforeEach(() => {
  useRunningTerminalCloseConfirmStore.setState({ runningTerminalCloseConfirm: null })
  forgetPromptFreeAgentTabLaunch(TAB)
  notePromptFreeAgentTabLaunch(TAB)
  bindPromptFreeAgentTabLaunch(TAB, LEAF, PTY)
  seedEmptyAgentPane(PTY)
})

describe('closing a never-tasked agent', () => {
  it('closes the launched process unasked when its probe answers live', async () => {
    probePtyRunningWork.mockResolvedValue([probe('live')])
    await expect(closeTab()).resolves.toBe('closed')
  })

  it.each([
    ['an unverifiable probe', probe('unverifiable')],
    ['a timed-out probe', probe('unverifiable', true)]
  ])('still asks on %s', async (_label, answer) => {
    probePtyRunningWork.mockResolvedValue([answer])
    await expect(closeTab()).resolves.toBe('asked')
  })

  it('still asks when the same tab now runs a different process (wake, resume, respawn)', async () => {
    seedEmptyAgentPane('pty-respawned')
    probePtyRunningWork.mockResolvedValue([{ ...probe('live'), ptyId: 'pty-respawned' }])
    await expect(closeTab()).resolves.toBe('asked')
  })

  it('still asks once the launch is forgotten (sleep, hibernation, close)', async () => {
    forgetPromptFreeAgentTabLaunch(TAB)
    probePtyRunningWork.mockResolvedValue([probe('live')])
    await expect(closeTab()).resolves.toBe('asked')
  })

  it('excuses a pane close only for the launched leaf', () => {
    expect(isProbeOfEmptyAgentSession(TAB, probe('live'), LEAF)).toBe(true)
    expect(isProbeOfEmptyAgentSession(TAB, probe('live'), OTHER_LEAF)).toBe(false)
    expect(isProbeOfEmptyAgentSession(TAB, probe('unverifiable'), LEAF)).toBe(false)
  })
})

describe('isPromptFreeAgentTabLaunch', () => {
  it('vouches only for a launch with nothing the status row cannot see', () => {
    const agent = 'claude' as const
    expect(isPromptFreeAgentTabLaunch({ agent }, {})).toBe(true)
    // An explicit null replaces configured default args with none.
    const resumeByDefault = { agentDefaultArgs: { claude: '--continue' } }
    expect(isPromptFreeAgentTabLaunch({ agent, agentArgs: null }, resumeByDefault)).toBe(true)
    expect(isPromptFreeAgentTabLaunch({ agent }, resumeByDefault)).toBe(false)
    // Settings' Yolo/Auto presets are permission flags only, not a resumed conversation.
    for (const preset of ['--dangerously-skip-permissions', '--permission-mode auto']) {
      expect(isPromptFreeAgentTabLaunch({ agent }, { agentDefaultArgs: { claude: preset } })).toBe(
        true
      )
    }
    const presetPlusResume = { agentDefaultArgs: { claude: '--dangerously-skip-permissions -c' } }
    expect(isPromptFreeAgentTabLaunch({ agent }, presetPlusResume)).toBe(false)
    expect(isPromptFreeAgentTabLaunch({ agent }, { agentCmdOverrides: { claude: 'wrap' } })).toBe(
      false
    )
    for (const change of [
      { prompt: 'fix the bug' },
      { agentArgs: '--resume abc' },
      { actionAgentArgs: '--fork-session' }
    ]) {
      expect(isPromptFreeAgentTabLaunch({ agent, ...change }, {})).toBe(false)
    }
  })
})
