// The CLI/runtime RPC used to refuse `--host ssh:*` with "set the project up from the Orca desktop
// app" — while the desktop IPC handler in the *same process* routed it correctly through
// addRemoteRepoFromPath. Safe but wrong: the process refusing is the one that owns the connection.
import { describe, expect, it, vi } from 'vitest'
import { RuntimeProjectHostSetupController } from './runtime-project-host-setup-controller'
import { getProjectHostSetupForRepo } from '../../shared/project-host-setup-lookup'
import { projectHostSetupProjectionFromRepos } from '../../shared/project-host-setup-projection'
import type { Repo } from '../../shared/repo-types'

// The layout write refreshes roots and watch targets, which touch the filesystem and Electron.
const { prepareRootMock, syncWatcherMock, invalidateRootsMock } = vi.hoisted(() => ({
  prepareRootMock: vi.fn(),
  syncWatcherMock: vi.fn(),
  invalidateRootsMock: vi.fn()
}))
vi.mock('../worktree-root-preparation', () => ({
  prepareLocalWorktreeRootForRepo: prepareRootMock,
  prepareLocalWorktreeRootsForRepos: vi.fn()
}))
vi.mock('../ipc/worktree-base-directory-watcher', () => ({
  scheduleCurrentWorktreeBaseDirectoryWatcherSync: syncWatcherMock
}))
vi.mock('../ipc/filesystem-auth', () => ({ invalidateAuthorizedRootsCache: invalidateRootsMock }))

const TARGET_ID = 'target-1'
const REMOTE_PATH = '/srv/app'

const remoteRepo = {
  id: 'repo-remote',
  path: REMOTE_PATH,
  displayName: 'app',
  badgeColor: 'blue',
  addedAt: 1,
  kind: 'git',
  connectionId: TARGET_ID
} as unknown as Repo

function makeController(
  options: {
    settings?: Record<string, unknown>
    canWriteSettings?: boolean
  } = {}
): {
  controller: RuntimeProjectHostSetupController
  addRepo: ReturnType<typeof vi.fn>
  addRemoteRepo: ReturnType<typeof vi.fn>
  cloneRepo: ReturnType<typeof vi.fn>
  projectId: string
  updateSettings: ReturnType<typeof vi.fn>
  createProjectHostSetup: ReturnType<typeof vi.fn>
  updateProjectHostSetup: ReturnType<typeof vi.fn>
} {
  const updateSettings = vi.fn()
  const createProjectHostSetup = vi.fn((args: { projectId: string; hostId: string }) => ({
    project: {
      id: args.projectId,
      displayName: 'Orca',
      badgeColor: '#000',
      sourceRepoIds: [],
      createdAt: 1,
      updatedAt: 1
    },
    setup: {
      id: 'setup-1',
      projectId: args.projectId,
      hostId: args.hostId,
      repoId: '',
      path: '',
      displayName: 'Orca',
      setupState: 'not-set-up',
      setupMethod: 'provisioned',
      createdAt: 1,
      updatedAt: 1
    }
  }))
  const updateProjectHostSetup = vi.fn(() => ({
    project: {
      id: 'github:stablyai/orca',
      displayName: 'Orca',
      badgeColor: '#000',
      sourceRepoIds: [],
      createdAt: 1,
      updatedAt: 1
    },
    setup: {
      id: 'setup-1',
      projectId: 'github:stablyai/orca',
      hostId: 'local',
      repoId: '',
      path: '',
      displayName: 'Orca',
      setupState: 'ready',
      setupMethod: 'provisioned',
      createdAt: 1,
      updatedAt: 2
    }
  }))
  const store = {
    getProjects: () => projectHostSetupProjectionFromRepos([remoteRepo]).projects,
    getProjectHostSetups: () => [],
    updateRepo: (_id: string, updates: Record<string, unknown>) => ({ ...remoteRepo, ...updates }),
    createProjectHostSetup,
    updateProjectHostSetup,
    ...(options.canWriteSettings === false
      ? {}
      : {
          getSettings: () => ({
            workspaceDir: '/orca/workspaces',
            nestWorkspaces: true,
            ...options.settings
          }),
          updateSettings
        })
  }
  const addRepo = vi.fn().mockResolvedValue(remoteRepo)
  const addRemoteRepo = vi.fn().mockResolvedValue(remoteRepo)
  const cloneRepo = vi.fn().mockResolvedValue(remoteRepo)
  const controller = new RuntimeProjectHostSetupController({
    getStore: () => store as never,
    listRepos: () => [remoteRepo],
    addRepo,
    addRemoteRepo,
    cloneRepo,
    invalidateResolvedWorktrees: vi.fn(),
    invalidateWorktreeScan: vi.fn(),
    notifyReposChanged: vi.fn()
  })
  return {
    controller,
    addRepo,
    addRemoteRepo,
    cloneRepo,
    projectId: getProjectHostSetupForRepo([], remoteRepo).projectId,
    updateSettings,
    createProjectHostSetup,
    updateProjectHostSetup
  }
}

describe('RuntimeProjectHostSetupController host routing', () => {
  it('registers an existing folder on an SSH host instead of refusing it (#11163)', async () => {
    const { controller, addRepo, addRemoteRepo, projectId } = makeController()

    const result = await controller.setupExistingFolder({
      projectId,
      hostId: `ssh:${TARGET_ID}`,
      path: REMOTE_PATH,
      kind: 'git'
    })

    expect(addRemoteRepo).toHaveBeenCalledWith({
      connectionId: TARGET_ID,
      remotePath: REMOTE_PATH,
      kind: 'git'
    })
    // The local registration path validates the path against the client filesystem.
    expect(addRepo).not.toHaveBeenCalled()
    expect(result.repo.id).toBe(remoteRepo.id)
  })

  it('decodes a percent-encoded SSH target back to its connection id', async () => {
    const { controller, addRemoteRepo, projectId } = makeController()

    await controller.setupExistingFolder({
      projectId,
      hostId: 'ssh:my%20host',
      path: REMOTE_PATH,
      kind: 'folder'
    })

    expect(addRemoteRepo).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'my host', kind: 'folder' })
    )
  })

  it('still uses the local registration for local and runtime hosts', async () => {
    const { controller, addRepo, addRemoteRepo, projectId } = makeController()

    await controller.setupExistingFolder({
      projectId,
      hostId: 'local',
      path: REMOTE_PATH,
      kind: 'git'
    })

    expect(addRepo).toHaveBeenCalledWith(REMOTE_PATH, 'git', 'local')
    expect(addRemoteRepo).not.toHaveBeenCalled()
  })

  it('refuses to clone onto an SSH host, because nothing here clones remotely', async () => {
    const { controller, cloneRepo, projectId } = makeController()

    await expect(
      controller.setupClone({
        projectId,
        hostId: `ssh:${TARGET_ID}`,
        url: 'https://example.com/app.git',
        destination: REMOTE_PATH
      })
    ).rejects.toThrow(/Cloning onto an SSH host is not supported/)
    expect(cloneRepo).not.toHaveBeenCalled()
  })
})

describe('RuntimeProjectHostSetupController layout mode', () => {
  it('writes the host-wide mode with the legacy boolean and refreshes derived placement', () => {
    const { controller, updateSettings, createProjectHostSetup } = makeController()

    controller.createSetup({
      projectId: 'p1',
      hostId: 'local',
      worktreeLayoutMode: 'project-folder'
    })

    expect(updateSettings).toHaveBeenCalledWith(
      { worktreeLayoutMode: 'project-folder', nestWorkspaces: true },
      { notifyListeners: true }
    )
    // Every root and watch target derived from the previous mode is now stale.
    expect(prepareRootMock).toHaveBeenCalled()
    expect(syncWatcherMock).toHaveBeenCalledOnce()
    // The mode is not a setup field, so the setup write must not carry it.
    expect(createProjectHostSetup).toHaveBeenCalledWith({ projectId: 'p1', hostId: 'local' })
  })

  it('leaves settings alone when the host already uses that mode', () => {
    const { controller, updateSettings } = makeController({
      settings: { worktreeLayoutMode: 'project-folder' }
    })

    controller.createSetup({
      projectId: 'p1',
      hostId: 'local',
      worktreeLayoutMode: 'project-folder'
    })

    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('fails the command when the host cannot write settings, before creating the setup', () => {
    const { controller, createProjectHostSetup } = makeController({ canWriteSettings: false })

    expect(() =>
      controller.createSetup({ projectId: 'p1', hostId: 'local', worktreeLayoutMode: 'flat' })
    ).toThrow('runtime_unavailable')
    expect(createProjectHostSetup).not.toHaveBeenCalled()
  })

  it('applies the mode through setup-update without leaking it into the setup record', () => {
    const { controller, updateSettings, updateProjectHostSetup } = makeController()

    controller.updateSetup({ setupId: 'setup-1', updates: { worktreeLayoutMode: 'flat' } })

    expect(updateSettings).toHaveBeenCalledWith(
      { worktreeLayoutMode: 'flat', nestWorkspaces: false },
      { notifyListeners: true }
    )
    expect(updateProjectHostSetup).toHaveBeenCalledWith({ setupId: 'setup-1', updates: {} })
  })
})
