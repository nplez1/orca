import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as WorktreeLogic from './worktree-logic'
import {
  listWorktreesMock,
  addWorktreeMock,
  getEffectiveHooksMock,
  createSetupRunnerScriptMock,
  getEffectiveHooksFromConfigMock,
  shouldRunSetupForCreateMock,
  loadHooksMock
} from './worktrees-test-module-mocks'
import { handlers, setupWorktreeHandlers, store } from './worktrees-test-harness'
import type { WorktreeRuntimeStub } from './worktrees-test-runtime-stub'

vi.mock('electron', async () =>
  (await import('./worktrees-test-module-mocks')).electronModuleMock()
)
vi.mock('../git/worktree', async () =>
  (await import('./worktrees-test-module-mocks')).gitWorktreeModuleMock()
)
vi.mock('../git/runner', async () =>
  (await import('./worktrees-test-module-mocks')).gitRunnerModuleMock()
)
vi.mock('../git/repo', async () =>
  (await import('./worktrees-test-module-mocks')).gitRepoModuleMock()
)
vi.mock('../git/git-username', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveLocalGitUsername: (await import('./worktrees-test-module-mocks'))
    .resolveLocalGitUsernameMock
}))
vi.mock('../github/client', async () =>
  (await import('./worktrees-test-module-mocks')).githubClientModuleMock()
)
vi.mock('../source-control/hosted-review', async () =>
  (await import('./worktrees-test-module-mocks')).hostedReviewModuleMock()
)
vi.mock('../providers/ssh-git-dispatch', async () =>
  (await import('./worktrees-test-module-mocks')).sshGitDispatchModuleMock()
)
vi.mock('../providers/ssh-filesystem-dispatch', async () =>
  (await import('./worktrees-test-module-mocks')).sshFilesystemDispatchModuleMock()
)
vi.mock('./worktree-symlinks', async () =>
  (await import('./worktrees-test-module-mocks')).worktreeSymlinksModuleMock()
)
vi.mock('./ssh', async () => (await import('./worktrees-test-module-mocks')).sshModuleMock())
vi.mock('../ssh/ssh-target-registry', async () =>
  (await import('./worktrees-test-module-mocks')).sshTargetRegistryModuleMock()
)
vi.mock('../hooks', async () => (await import('./worktrees-test-module-mocks')).hooksModuleMock())
vi.mock('../setup-runner-script-text', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).setupRunnerScriptTextModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../worktree-runner-script', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).worktreeRunnerScriptModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../effective-hook-config', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).effectiveHookConfigModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../setup-hook-env-vars', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).setupHookEnvVarsModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('./worktree-logic', async (importOriginal) => {
  const actual = await importOriginal<typeof WorktreeLogic>()
  return {
    ...(await import('./worktrees-test-module-mocks')).worktreeLogicModuleMock(actual),
    computeWorkspaceRootAsync: vi.fn(actual.computeWorkspaceRootAsync)
  }
})
vi.mock('../terminal-history-deletion', async () =>
  (await import('./worktrees-test-module-mocks')).terminalHistoryDeletionModuleMock()
)
vi.mock('../ports/advertised-url-watcher', async () =>
  (await import('./worktrees-test-module-mocks')).advertisedUrlWatcherModuleMock()
)
vi.mock('../workspace-cleanup-scan-snapshot', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceCleanupScanSnapshotModuleMock()
)
vi.mock('../workspace-space-analysis-snapshot', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceSpaceAnalysisSnapshotModuleMock()
)
vi.mock('../workspace-cleanup-removal-snapshot-prune', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceCleanupRemovalSnapshotPruneModuleMock()
)
vi.mock('../runtime/worktree-teardown', async () =>
  (await import('./worktrees-test-module-mocks')).worktreeTeardownModuleMock()
)
vi.mock('./pty', async () => (await import('./worktrees-test-module-mocks')).ptyModuleMock())

describe('registerWorktreeHandlers', () => {
  let runtimeStub: WorktreeRuntimeStub

  beforeEach(() => {
    runtimeStub = setupWorktreeHandlers()
  })

  it('spawns a startup terminal and setup terminal after local worktree registration', async () => {
    addWorktreeMock.mockResolvedValue({})
    listWorktreesMock.mockResolvedValueOnce([
      {
        path: '/workspace/improve-dashboard',
        head: 'def',
        branch: 'improve-dashboard',
        isBare: false,
        isMainWorktree: false
      }
    ])
    loadHooksMock.mockReturnValue({
      scripts: { setup: 'pnpm install' },
      setupAgentStartupPolicy: 'wait-for-setup'
    })
    getEffectiveHooksMock.mockReturnValue({ scripts: { setup: 'pnpm install' } })
    getEffectiveHooksFromConfigMock.mockReturnValue({ scripts: { setup: 'pnpm install' } })
    shouldRunSetupForCreateMock.mockReturnValue(true)
    expect(createSetupRunnerScriptMock).not.toHaveBeenCalled()

    const result = (await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard',
      createdWithAgent: 'claude',
      startup: {
        command: 'claude --prefill test',
        env: { ORCA_AGENT_MODE: 'direct' },
        viewMode: 'chat',
        telemetry: {
          agent_kind: 'claude',
          launch_source: 'new_workspace_composer',
          request_kind: 'new'
        }
      }
    })) as {
      setup?: unknown
      startupTerminal?: { spawned: boolean; surface?: string }
      timing?: {
        phases: { phase: string }[]
        preparedCheckout?: { status: string; reason?: string }
      }
    }
    expect(createSetupRunnerScriptMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'repo-1' }),
      '/workspace/improve-dashboard',
      'pnpm install',
      undefined,
      undefined,
      'wait-for-setup'
    )

    expect(runtimeStub.createTerminal).toHaveBeenNthCalledWith(
      1,
      'id:repo-1::/workspace/improve-dashboard',
      {
        claudeAgentTeamsSourceCommand: 'claude --prefill test',
        command: 'claude --prefill test',
        env: { ORCA_AGENT_MODE: 'direct' },
        launchAgent: 'claude',
        viewMode: 'chat',
        startupCommandDelivery: undefined,
        telemetry: {
          agent_kind: 'claude',
          launch_source: 'new_workspace_composer',
          request_kind: 'new'
        },
        surfaceOwner: false
      }
    )
    expect(runtimeStub.createTerminal).toHaveBeenNthCalledWith(
      2,
      'id:repo-1::/workspace/improve-dashboard',
      {
        title: 'Setup',
        command: expect.stringContaining('bash /workspace/repo/.git/orca/setup-runner.sh'),
        env: {
          ORCA_ROOT_PATH: '/workspace/repo',
          ORCA_WORKTREE_PATH: '/workspace/improve-dashboard'
        },
        activate: false,
        surfaceOwner: false
      }
    )
    const startupCreateCall = runtimeStub.createTerminal.mock.calls[0]
    const setupCreateCall = runtimeStub.createTerminal.mock.calls[1]
    if (!startupCreateCall || !setupCreateCall) {
      throw new Error('expected startup and setup terminal calls')
    }
    // The submitting renderer decides whether to open the new workspace, so the host must not
    // activate it for the startup terminal (#9944).
    expect(startupCreateCall[1]).not.toHaveProperty('activate')
    const startupCommand = (startupCreateCall[1] as { command: string }).command
    const setupCommand = (setupCreateCall[1] as { command: string }).command
    expect(startupCommand).toBe('claude --prefill test')
    // Why the wrapper: it is the only shell-agnostic way to learn the runner
    // ended (cmd.exe emits no OSC 133), so the sidebar can leave "Setting up".
    expect(setupCommand).toContain('bash /workspace/repo/.git/orca/setup-runner.sh')
    expect(setupCommand).toContain('__ORCA_SETUP_COMPLETE__:')
    expect(runtimeStub.armWorktreeSetupRunner).toHaveBeenCalledWith(
      'term-startup',
      'repo-1::/workspace/improve-dashboard',
      expect.any(String)
    )
    expect(result.setup).toBeUndefined()
    expect(result.startupTerminal).toEqual({ spawned: true, surface: 'visible' })
    expect(runtimeStub.invalidateWorktreeCatalog).toHaveBeenCalledWith('repo-1')
    expect(runtimeStub.invalidateWorktreeCatalog.mock.invocationCallOrder[0]).toBeLessThan(
      runtimeStub.createTerminal.mock.invocationCallOrder[0]
    )
    expect(result.timing?.phases.map((phase) => phase.phase)).toEqual(
      expect.arrayContaining([
        'git_worktree_add',
        'list_created_worktree',
        'resolve_worktreeinclude',
        'prepare_setup',
        'spawn_startup_terminal'
      ])
    )
    // Nothing warmed this repo, so the create must report the cold path rather than stay silent.
    expect(result.timing?.preparedCheckout).toEqual({ status: 'miss', reason: 'none_armed' })
  })

  it('spawns and observes setup for a blank local worktree create', async () => {
    addWorktreeMock.mockResolvedValue({})
    listWorktreesMock.mockResolvedValueOnce([
      {
        path: '/workspace/improve-dashboard',
        head: 'def',
        branch: 'improve-dashboard',
        isBare: false,
        isMainWorktree: false
      }
    ])
    loadHooksMock.mockReturnValue({ scripts: { setup: 'pnpm install' } })
    getEffectiveHooksMock.mockReturnValue({ scripts: { setup: 'pnpm install' } })
    getEffectiveHooksFromConfigMock.mockReturnValue({ scripts: { setup: 'pnpm install' } })
    shouldRunSetupForCreateMock.mockReturnValue(true)
    runtimeStub.createTerminal
      .mockResolvedValueOnce({ handle: 'term-primary', surface: 'visible' })
      .mockResolvedValueOnce({ handle: 'term-setup' })

    const result = await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard'
    })

    expect(runtimeStub.createTerminal).toHaveBeenCalledTimes(2)
    expect(runtimeStub.createTerminal).toHaveBeenNthCalledWith(
      1,
      'id:repo-1::/workspace/improve-dashboard',
      { activate: true }
    )
    expect(runtimeStub.createTerminal).toHaveBeenNthCalledWith(
      2,
      'id:repo-1::/workspace/improve-dashboard',
      expect.objectContaining({
        title: 'Setup',
        command: expect.stringContaining('__ORCA_SETUP_COMPLETE__:'),
        activate: false
      })
    )
    expect(runtimeStub.armWorktreeSetupRunner).toHaveBeenCalledWith(
      'term-setup',
      'repo-1::/workspace/improve-dashboard',
      expect.any(String)
    )
    expect(result).not.toHaveProperty('setup')
    expect(result).toMatchObject({
      startupTerminal: { spawned: true, surface: 'visible' }
    })
  })

  it('returns the wrapped setup command when startup spawned but setup creation failed', async () => {
    addWorktreeMock.mockResolvedValue({})
    listWorktreesMock.mockResolvedValueOnce([
      {
        path: '/workspace/improve-dashboard',
        head: 'def',
        branch: 'improve-dashboard',
        isBare: false,
        isMainWorktree: false
      }
    ])
    loadHooksMock.mockReturnValue({ scripts: { setup: 'pnpm install' } })
    getEffectiveHooksMock.mockReturnValue({ scripts: { setup: 'pnpm install' } })
    getEffectiveHooksFromConfigMock.mockReturnValue({ scripts: { setup: 'pnpm install' } })
    shouldRunSetupForCreateMock.mockReturnValue(true)
    createSetupRunnerScriptMock.mockReturnValueOnce({
      runnerScriptPath: 'C:\\workspace\\repo\\.git\\orca\\setup-runner.sh',
      shell: { family: 'posix', executable: 'wsl.exe' },
      envVars: {
        ORCA_ROOT_PATH: 'C:\\workspace\\repo',
        ORCA_WORKTREE_PATH: 'C:\\workspace\\improve-dashboard'
      },
      waitForAgentStartup: true
    })
    runtimeStub.createTerminal
      .mockResolvedValueOnce({ handle: 'term-startup', surface: 'visible' })
      .mockRejectedValueOnce(new Error('setup creation failed'))

    const result = (await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard',
      createdWithAgent: 'claude',
      startup: {
        command: 'claude --prefill test',
        env: { ORCA_AGENT_MODE: 'direct' },
        telemetry: {
          agent_kind: 'claude',
          launch_source: 'new_workspace_composer',
          request_kind: 'new'
        }
      }
    })) as { setup?: { command?: string; runnerScriptPath: string } }

    expect(result.setup).toEqual(
      expect.objectContaining({
        runnerScriptPath: 'C:\\workspace\\repo\\.git\\orca\\setup-runner.sh',
        command: expect.stringContaining('bash /mnt/c/workspace/repo/.git/orca/setup-runner.sh')
      })
    )
    expect(result.setup?.command).toContain('printf')
  })

  it('splits split-mode setup into the startup terminal without surfacing the workspace', async () => {
    addWorktreeMock.mockResolvedValue({})
    listWorktreesMock.mockResolvedValueOnce([
      {
        path: '/workspace/improve-dashboard',
        head: 'def',
        branch: 'improve-dashboard',
        isBare: false,
        isMainWorktree: false
      }
    ])
    store.getSettings.mockReturnValue({
      branchPrefix: 'none',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      workspaceDir: '/workspace',
      setupScriptLaunchMode: 'split-vertical'
    })
    loadHooksMock.mockReturnValue({ scripts: { setup: 'pnpm install' } })
    getEffectiveHooksMock.mockReturnValue({ scripts: { setup: 'pnpm install' } })
    getEffectiveHooksFromConfigMock.mockReturnValue({ scripts: { setup: 'pnpm install' } })
    shouldRunSetupForCreateMock.mockReturnValue(true)

    await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard',
      createdWithAgent: 'claude',
      startup: { command: 'claude' }
    })

    expect(runtimeStub.createTerminal).toHaveBeenCalledTimes(1)
    // A user who moved on must not be scrolled to the new workspace by its setup pane (#9944).
    expect(runtimeStub.splitTerminal).toHaveBeenCalledWith('term-startup', {
      direction: 'vertical',
      command: expect.stringContaining('setup-runner.sh'),
      env: expect.any(Object),
      activate: false,
      surfaceOwner: false
    })
  })
})
