import { describe, expect, it, vi } from 'vitest'
import { RuntimeProjectHostSetupController } from './runtime-project-host-setup-controller'
import { SERVER_SSH_PROJECT_ADD_UNAVAILABLE_MESSAGE } from '../../shared/project-host-setup-target'
import type { Project, ProjectHostSetup } from '../../shared/project-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import { getProjectHostSetupForRepo } from '../../shared/project-host-setup-lookup'
import { projectHostSetupProjectionFromRepos } from '../../shared/project-host-setup-projection'
import type { Repo } from '../../shared/repo-types'
import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'

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
vi.mock('../ipc/filesystem/filesystem-auth', () => ({
  invalidateAuthorizedRootsCache: invalidateRootsMock
}))

const TARGET_ID = 'target-1'
const REPO_PATH = '/srv/app'

const repo: Repo = {
  id: 'repo-1',
  path: REPO_PATH,
  displayName: 'app',
  badgeColor: 'blue',
  addedAt: 1,
  kind: 'git'
}

function makeProject(id: string): Project {
  return {
    id,
    displayName: 'Orca',
    badgeColor: '#000',
    sourceRepoIds: [],
    createdAt: 1,
    updatedAt: 1
  }
}

function makeSetup(
  setupId: string,
  projectId: string,
  hostId: ExecutionHostId = 'local'
): ProjectHostSetup {
  return {
    id: setupId,
    projectId,
    hostId,
    repoId: '',
    path: '',
    displayName: 'Orca',
    setupState: 'ready',
    setupMethod: 'provisioned',
    createdAt: 1,
    updatedAt: 1
  }
}

function makeController(
  options: {
    settings?: Record<string, unknown>
    canWriteSettings?: boolean
    /** Projects this host knows; absent keeps the projected-from-repos default. */
    projects?: Project[]
    /** Setups this host knows; absent reports none. */
    setups?: ProjectHostSetup[]
    /** A store whose settings write silently does nothing, as an older host looks from here. */
    ignoreSettingsWrites?: boolean
    /** The setup write itself fails, as a kind conversion or a validation refusal does. */
    cleanupWriteFails?: boolean
  } = {}
): {
  controller: RuntimeProjectHostSetupController
  addRepo: ReturnType<typeof vi.fn>
  cloneRepo: ReturnType<typeof vi.fn>
  projectId: string
  updateSettings: ReturnType<typeof vi.fn>
  createProjectHostSetup: ReturnType<typeof vi.fn>
  updateProjectHostSetup: ReturnType<typeof vi.fn>
} {
  const settings: Record<string, unknown> = {
    workspaceDir: '/orca/workspaces',
    nestWorkspaces: true,
    ...options.settings
  }
  const updateSettings = vi.fn((updates: Record<string, unknown>) => {
    if (!options.ignoreSettingsWrites) {
      Object.assign(settings, updates)
    }
  })
  const createProjectHostSetup = vi.fn((args: { projectId: string; hostId: string }) => {
    if (options.cleanupWriteFails) {
      throw new Error('This folder project cannot be converted.')
    }
    // Why null: that is what the store answers for a project this host does not have.
    if (options.projects && !options.projects.some((entry) => entry.id === args.projectId)) {
      return null
    }
    return {
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
    }
  })
  const updateProjectHostSetup = vi.fn((args: { setupId: string }) => {
    if (options.setups && !options.setups.some((entry) => entry.id === args.setupId)) {
      return null
    }
    return {
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
    }
  })
  const store = {
    getProjects: () => options.projects ?? projectHostSetupProjectionFromRepos([repo]).projects,
    getProjectHostSetups: () => options.setups ?? [],
    updateRepo: (_target: unknown, updates: Record<string, unknown>) => ({ ...repo, ...updates }),
    createProjectHostSetup,
    updateProjectHostSetup,
    ...(options.canWriteSettings === false
      ? {}
      : {
          getSettings: () => settings,
          updateSettings
        })
  }
  const addRepo = vi.fn().mockResolvedValue(repo)
  const cloneRepo = vi.fn().mockResolvedValue(repo)
  const controller = new RuntimeProjectHostSetupController({
    getStore: () => store as never,
    listRepos: () => [repo],
    addRepo,
    cloneRepo,
    invalidateResolvedWorktrees: vi.fn(),
    invalidateWorktreeScan: vi.fn(),
    notifyReposChanged: vi.fn(),
    countLiveTerminalsForRepo: () => 0
  })
  return {
    controller,
    addRepo,
    cloneRepo,
    projectId: getProjectHostSetupForRepo([], repo).projectId,
    updateSettings,
    createProjectHostSetup,
    updateProjectHostSetup
  }
}

describe('RuntimeProjectHostSetupController host routing', () => {
  it('refuses an existing folder on an SSH target with the not-connected text, never locally', async () => {
    const { controller, addRepo, projectId } = makeController()

    const setup = controller.setupExistingFolder({
      projectId,
      hostId: `ssh:${TARGET_ID}`,
      path: REPO_PATH,
      kind: 'git'
    })

    await expect(setup).rejects.toThrow(SshHostNotServedError)
    await expect(setup).rejects.toThrow(SERVER_SSH_PROJECT_ADD_UNAVAILABLE_MESSAGE)
    expect(addRepo).not.toHaveBeenCalled()
  })

  it('preserves the decoded connection id when refusing a percent-encoded SSH target', async () => {
    const { controller, addRepo, projectId } = makeController()

    await expect(
      controller.setupExistingFolder({
        projectId,
        hostId: 'ssh:my%20host',
        path: REPO_PATH,
        kind: 'folder'
      })
    ).rejects.toMatchObject({
      code: 'ssh_host_not_served',
      connectionId: 'my host',
      message: SERVER_SSH_PROJECT_ADD_UNAVAILABLE_MESSAGE
    })
    expect(addRepo).not.toHaveBeenCalled()
  })

  it('refuses repo.addRemote by saying where the project can be added instead', () => {
    const { controller, addRepo } = makeController()

    expect(() => controller.addSshRepo({ connectionId: TARGET_ID })).toThrow(
      SERVER_SSH_PROJECT_ADD_UNAVAILABLE_MESSAGE
    )
    expect(addRepo).not.toHaveBeenCalled()
  })

  it('still uses the local registration for local and runtime hosts', async () => {
    const { controller, addRepo, projectId } = makeController()

    await controller.setupExistingFolder({
      projectId,
      hostId: 'local',
      path: REPO_PATH,
      kind: 'git'
    })

    expect(addRepo).toHaveBeenCalledWith(REPO_PATH, 'git', 'local')
  })

  it('refuses to clone onto an SSH host, because nothing here clones remotely', async () => {
    const { controller, cloneRepo, projectId } = makeController()

    await expect(
      controller.setupClone({
        projectId,
        hostId: `ssh:${TARGET_ID}`,
        url: 'https://example.com/app.git',
        destination: REPO_PATH
      })
    ).rejects.toThrow(/Cloning onto an SSH host is not supported/)
    expect(cloneRepo).not.toHaveBeenCalled()
  })
})

describe('RuntimeProjectHostSetupController layout mode', () => {
  const layoutFixture = () => ({
    projects: [makeProject('p1')],
    setups: [makeSetup('setup-1', 'p1')]
  })

  it('writes the host-wide mode with the legacy boolean and refreshes derived placement', () => {
    const { controller, updateSettings, createProjectHostSetup } = makeController(layoutFixture())

    const result = controller.createSetup({
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
    // Why echoed: the caller has to be able to prove the host applied what it was asked for.
    expect(result.worktreeLayoutMode).toBe('project-folder')
  })

  it('leaves settings alone when the host already uses that mode', () => {
    const { controller, updateSettings } = makeController({
      ...layoutFixture(),
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
    const { controller, createProjectHostSetup } = makeController({
      ...layoutFixture(),
      canWriteSettings: false
    })

    expect(() =>
      controller.createSetup({ projectId: 'p1', hostId: 'local', worktreeLayoutMode: 'flat' })
    ).toThrow('runtime_unavailable')
    expect(createProjectHostSetup).not.toHaveBeenCalled()
  })

  it('refuses a create for an unknown project without touching the host-wide mode', () => {
    // Why: the mode applies to every project on this host, so writing it for a project that
    // does not exist flips all of them and then fails the command.
    const { controller, updateSettings, createProjectHostSetup } = makeController(layoutFixture())

    expect(() =>
      controller.createSetup({
        projectId: 'no-such-project',
        hostId: 'local',
        worktreeLayoutMode: 'flat'
      })
    ).toThrow('Project not found: no-such-project')
    expect(updateSettings).not.toHaveBeenCalled()
    expect(createProjectHostSetup).toHaveBeenCalledOnce()
  })

  it('does not move the host-wide mode when the setup write itself fails', () => {
    const { controller, updateSettings } = makeController({
      ...layoutFixture(),
      cleanupWriteFails: true
    })

    expect(() =>
      controller.createSetup({ projectId: 'p1', hostId: 'local', worktreeLayoutMode: 'flat' })
    ).toThrow('cannot be converted')
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('applies the mode through setup-update without leaking it into the setup record', async () => {
    const { controller, updateSettings, updateProjectHostSetup } = makeController(layoutFixture())

    const result = await controller.updateSetup({
      setupId: 'setup-1',
      updates: { worktreeLayoutMode: 'flat' }
    })

    expect(updateSettings).toHaveBeenCalledWith(
      { worktreeLayoutMode: 'flat', nestWorkspaces: false },
      { notifyListeners: true }
    )
    expect(updateProjectHostSetup).toHaveBeenCalledWith({ setupId: 'setup-1', updates: {} })
    expect(result.worktreeLayoutMode).toBe('flat')
  })

  it('refuses an update for an unknown setup without touching the host-wide mode', async () => {
    const { controller, updateSettings, updateProjectHostSetup } = makeController(layoutFixture())

    await expect(
      controller.updateSetup({ setupId: 'no-such-id', updates: { worktreeLayoutMode: 'flat' } })
    ).rejects.toThrow('Project host setup not found: no-such-id')
    // The store write is what proves the setup exists, so it runs; the host-wide mode must not.
    expect(updateProjectHostSetup).toHaveBeenCalledOnce()
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('reports no mode when the call carried none', () => {
    const { controller } = makeController(layoutFixture())

    const result = controller.createSetup({ projectId: 'p1', hostId: 'local' })

    expect(result).not.toHaveProperty('worktreeLayoutMode')
  })

  it('reports the mode actually in effect, so a swallowed write cannot look applied', async () => {
    // A store whose settings write silently does nothing is what an older host looks like
    // from here; the result must not repeat the request back as if it had landed.
    const { controller } = makeController({
      ...layoutFixture(),
      settings: { worktreeLayoutMode: 'repo-nested' },
      ignoreSettingsWrites: true
    })

    const result = await controller.updateSetup({
      setupId: 'setup-1',
      updates: { worktreeLayoutMode: 'flat' }
    })

    expect(result.worktreeLayoutMode).toBe('repo-nested')
  })
})
