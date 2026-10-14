import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Automation, AutomationRun } from '../../../shared/automations-types'
import { AUTOMATION_PROJECT_CONTEXT_MARKER } from '../../../shared/automation-project-context'

const WORKTREE_ID = 'repo-1::/work/orca-auto'
const mocks = vi.hoisted(() => ({
  launchAgentBackgroundSession: vi.fn(),
  markDispatchResult: vi.fn(async () => undefined),
  prepareAutomationDispatchWorkspace: vi.fn(),
  submitPromptToAgentPty: vi.fn(),
  findReusableAutomationSession: vi.fn(),
  observeExistingAutomationSession: vi.fn(),
  completion: {
    appendOutput: vi.fn(),
    captureAssistantMessage: vi.fn(),
    cleanupRunObservers: vi.fn(),
    handleAgentDone: vi.fn(),
    handleExit: vi.fn(),
    observeAgentStatus: vi.fn(),
    setReuseDispatchTabRelease: vi.fn(),
    setSessionObserver: vi.fn(),
    settlePendingAfterDispatch: vi.fn(async () => undefined)
  }
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      activeView: 'automations',
      activeWorktreeId: 'repo-1::/work/orca-auto',
      activeTabId: null,
      activeTabType: null,
      repos: []
    })
  }
}))

vi.mock('@/lib/launch-agent-background-session', () => ({
  launchAgentBackgroundSession: mocks.launchAgentBackgroundSession
}))

vi.mock('@/lib/agent-paste-draft', () => ({ submitPromptToAgentPty: mocks.submitPromptToAgentPty }))
vi.mock('@/lib/automation-session-observer', () => ({
  observeExistingAutomationSession: mocks.observeExistingAutomationSession
}))
vi.mock('@/lib/automation-session-reuse', () => ({
  findReusableAutomationSession: mocks.findReusableAutomationSession
}))
vi.mock('@/lib/automation-terminal-ownership', () => ({}))
vi.mock('@/components/automations/automation-host-client', () => ({
  listAutomationRunsForTarget: vi.fn(async () => [])
}))

vi.mock('@/hooks/automation-dispatch-completion', () => ({
  createAutomationDispatchCompletion: () => mocks.completion
}))

vi.mock('@/hooks/automation-dispatch-workspace', () => ({
  resolveAutomationDispatchWorkspace: () => ({
    runRepoId: 'repo-1',
    repo: { id: 'repo-1', displayName: 'orca', path: '/work/orca' },
    automationWorkspaceScope: null,
    automationWorktree: null,
    context: { workspaceId: null, workspaceDisplayName: null, precheckResult: null }
  }),
  prepareAutomationDispatchWorkspace: mocks.prepareAutomationDispatchWorkspace
}))

import { handleAutomationDispatchRequest } from './automation-dispatch-handler'

const automation: Automation = {
  id: 'automation-1',
  name: 'Nightly review',
  prompt: 'Review open changes',
  precheck: null,
  agentId: 'codex',
  runContext: {
    kind: 'workspace-run',
    projectId: 'project-1',
    hostId: 'ssh:ssh-target-1',
    projectHostSetupId: 'setup-1',
    repoId: 'repo-1',
    path: '/work/orca'
  },
  sourceContext: null,
  projectId: 'repo-1',
  executionTargetType: 'ssh',
  executionTargetId: 'ssh-target-1',
  schedulerOwner: 'remote_host_service',
  workspaceMode: 'new_per_run',
  workspaceId: null,
  baseBranch: null,
  reuseSession: false,
  timezone: 'UTC',
  rrule: 'FREQ=DAILY',
  dtstart: 1,
  enabled: true,
  nextRunAt: 2,
  missedRunPolicy: 'run_once_within_grace',
  missedRunGraceMinutes: 720,
  createdAt: 1,
  updatedAt: 1
}

const run: AutomationRun = {
  id: 'run-1',
  automationId: 'automation-1',
  title: 'Nightly review',
  scheduledFor: 1,
  status: 'dispatching',
  trigger: 'scheduled',
  workspaceId: null,
  sessionKind: 'terminal',
  chatSessionId: null,
  terminalSessionId: null,
  terminalPaneKey: null,
  terminalPtyId: null,
  outputSnapshot: null,
  precheckResult: null,
  usage: null,
  error: null,
  startedAt: null,
  dispatchedAt: null,
  createdAt: 1
}

describe('automation dispatch prompt', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('window', {
      api: { automations: { markDispatchResult: mocks.markDispatchResult } }
    })
    mocks.prepareAutomationDispatchWorkspace.mockResolvedValue({
      id: WORKTREE_ID,
      repoId: 'repo-1',
      displayName: 'auto-nightly'
    })
    mocks.launchAgentBackgroundSession.mockResolvedValue({
      tabId: 'tab-1',
      paneKey: 'tab-1:leaf-1',
      ptyId: 'pty-1',
      terminalOwnership: null
    })
    mocks.findReusableAutomationSession.mockReturnValue(null)
    mocks.observeExistingAutomationSession.mockResolvedValue(() => undefined)
    mocks.submitPromptToAgentPty.mockResolvedValue(true)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('hands the agent the prompt prefixed with the assigned project context', async () => {
    await handleAutomationDispatchRequest({ automation, run, dispatchToken: 'token-1' })

    expect(mocks.launchAgentBackgroundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: [
          AUTOMATION_PROJECT_CONTEXT_MARKER,
          'Project: orca (project-1)',
          'Host: ssh:ssh-target-1',
          "Project root: /work/orca (shared checkout, not necessarily this run's workspace)",
          '',
          'Review open changes'
        ].join('\n')
      })
    )
  })

  it('leaves the prompt alone when the record names no project', async () => {
    await handleAutomationDispatchRequest({
      automation: { ...automation, runContext: null, projectId: '' },
      run,
      dispatchToken: 'token-2'
    })

    expect(mocks.launchAgentBackgroundSession).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'Review open changes' })
    )
  })

  it('submits the composed prompt into a reused automation session', async () => {
    mocks.findReusableAutomationSession.mockReturnValue({
      tabId: 'tab-reused',
      paneKey: 'tab-reused:leaf-1',
      ptyId: 'pty-reused'
    })

    await handleAutomationDispatchRequest({
      automation: { ...automation, reuseSession: true },
      run,
      dispatchToken: 'token-3'
    })

    expect(mocks.submitPromptToAgentPty).toHaveBeenCalledWith({
      tabId: 'tab-reused',
      ptyId: 'pty-reused',
      content: [
        AUTOMATION_PROJECT_CONTEXT_MARKER,
        'Project: orca (project-1)',
        'Host: ssh:ssh-target-1',
        "Project root: /work/orca (shared checkout, not necessarily this run's workspace)",
        '',
        'Review open changes'
      ].join('\n')
    })
    expect(mocks.launchAgentBackgroundSession).not.toHaveBeenCalled()
  })
})
