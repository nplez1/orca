import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../../../shared/constants'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId
} from '../../../../../../shared/execution-host'
import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import type { WorktreeLayoutMode } from '../../../../../../shared/orca-workspace-layout'
import { resolveDefaultCreateProjectParent } from '../../../../../../main/ipc/repos/default-create-project-parent'
import { getCloneParentForHost } from './clone-defaults'
import { resolveRuntimeCreateParent } from './runtime-create-parent'

const browseRuntimeServerDirectory = vi.hoisted(() => vi.fn())

vi.mock('@/runtime/files/reads/runtime-server-directory-browser', () => ({
  browseRuntimeServerDirectory
}))

const SERVER_ID = 'server-a'
const SERVER = toRuntimeExecutionHostId(SERVER_ID)
const LOCAL_HOME = '/Users/me'
const RUNTIME_HOME = '/home/a'

const STORED_CASES: {
  name: string
  overrides: GlobalSettings['hostSettingOverrides']
}[] = [
  { name: 'nothing stored', overrides: {} },
  {
    name: 'a worktree root the user named',
    overrides: { [SERVER]: { defaultWorktreeLocation: '/srv/wt' } }
  },
  {
    name: 'Orca’s own workspaces tree as the worktree root',
    overrides: {
      [SERVER]: { defaultWorktreeLocation: `${RUNTIME_HOME}/orca/workspaces` }
    }
  },
  {
    name: 'a stored repo root',
    overrides: {
      [SERVER]: { defaultRepoRoot: '/srv/checkouts', defaultWorktreeLocation: '/srv/wt' }
    }
  }
]

function settingsWith(
  layoutMode: WorktreeLayoutMode,
  overrides: GlobalSettings['hostSettingOverrides'] = {}
): GlobalSettings {
  return {
    ...getDefaultSettings(LOCAL_HOME),
    worktreeLayoutMode: layoutMode,
    hostSettingOverrides: overrides
  }
}

beforeEach(() => {
  browseRuntimeServerDirectory.mockReset()
  browseRuntimeServerDirectory.mockResolvedValue({ resolvedPath: RUNTIME_HOME, entries: [] })
})

describe('the checkout folder is one rule for clone, the Settings row and create-project', () => {
  it('agrees on this computer under a flat layout', () => {
    // The seeded workspace dir is <home>/orca/workspaces — the case the issue reports.
    const settings = settingsWith('flat')
    const row = getCloneParentForHost({
      settings,
      hostIds: [LOCAL_EXECUTION_HOST_ID],
      layoutMode: 'flat'
    })
    expect(row).toBe('/Users/me/orca/projects')
    expect(resolveDefaultCreateProjectParent(settings, LOCAL_HOME)).toBe(row)
  })

  it('agrees on this computer under a nested layout', () => {
    const settings = settingsWith('repo-nested')
    const row = getCloneParentForHost({
      settings,
      hostIds: [LOCAL_EXECUTION_HOST_ID],
      layoutMode: 'repo-nested'
    })
    expect(row).toBe('/Users/me/orca/workspaces')
    expect(resolveDefaultCreateProjectParent(settings, LOCAL_HOME)).toBe(row)
  })

  it('agrees on this computer with a worktree root the user named', () => {
    for (const layoutMode of ['flat', 'repo-nested'] as const) {
      const settings = settingsWith(layoutMode, {
        [LOCAL_EXECUTION_HOST_ID]: { defaultWorktreeLocation: '/data/wt' }
      })
      const row = getCloneParentForHost({
        settings,
        hostIds: [LOCAL_EXECUTION_HOST_ID],
        layoutMode
      })
      expect(row).toBe('/data/wt')
      expect(resolveDefaultCreateProjectParent(settings, LOCAL_HOME)).toBe(row)
    }
  })

  it('agrees on this computer with a stored repo root, in every layout', () => {
    for (const layoutMode of ['flat', 'repo-nested', 'project-folder'] as const) {
      const settings = settingsWith(layoutMode, {
        [LOCAL_EXECUTION_HOST_ID]: { defaultRepoRoot: '/data/checkouts' }
      })
      const row = getCloneParentForHost({
        settings,
        hostIds: [LOCAL_EXECUTION_HOST_ID],
        layoutMode
      })
      expect(row).toBe('/data/checkouts')
      expect(resolveDefaultCreateProjectParent(settings, LOCAL_HOME)).toBe(row)
    }
  })

  it.each(STORED_CASES)(
    'agrees with create-project on a runtime host with $name',
    async ({ overrides }) => {
      for (const layoutMode of ['flat', 'repo-nested', 'project-folder'] as const) {
        const settings = settingsWith(layoutMode, overrides)
        const clone = getCloneParentForHost({
          settings,
          hostIds: [SERVER],
          layoutMode,
          hostHome: RUNTIME_HOME
        })
        const create = (
          await resolveRuntimeCreateParent({
            runtimeEnvironmentId: SERVER_ID,
            worktreeLayoutMode: layoutMode,
            hostSettingOverrides: overrides
          })
        ).parent
        expect(create).toBe(clone)
      }
    }
  )

  it('puts a flat-layout clone and create in the same folder on a runtime host', async () => {
    expect(
      getCloneParentForHost({
        settings: settingsWith('flat'),
        hostIds: [SERVER],
        layoutMode: 'flat',
        hostHome: RUNTIME_HOME
      })
    ).toBe('/home/a/orca/projects')
    expect(
      (
        await resolveRuntimeCreateParent({
          runtimeEnvironmentId: SERVER_ID,
          worktreeLayoutMode: 'flat',
          hostSettingOverrides: {}
        })
      ).parent
    ).toBe('/home/a/orca/projects')
  })

  it('keeps a flat-layout worktree root the user named, without probing the host', async () => {
    const overrides = { [SERVER]: { defaultWorktreeLocation: '/srv/wt' } }
    expect(
      getCloneParentForHost({
        settings: settingsWith('flat', overrides),
        hostIds: [SERVER],
        layoutMode: 'flat',
        hostHome: RUNTIME_HOME
      })
    ).toBe('/srv/wt')
    expect(
      (
        await resolveRuntimeCreateParent({
          runtimeEnvironmentId: SERVER_ID,
          worktreeLayoutMode: 'flat',
          hostSettingOverrides: overrides
        })
      ).parent
    ).toBe('/srv/wt')
    expect(browseRuntimeServerDirectory).not.toHaveBeenCalled()
  })

  it('keeps a relative workspace dir out of the clone default, as main refuses it too', () => {
    // #410's contract: a relative workspace dir is a per-project location, so clone has no
    // destination while create-project still falls back to the layout convention.
    const settings = { ...settingsWith('flat'), workspaceDir: '.orca/worktrees' }
    expect(
      getCloneParentForHost({ settings, hostIds: [LOCAL_EXECUTION_HOST_ID], layoutMode: 'flat' })
    ).toBe('')
    expect(resolveDefaultCreateProjectParent(settings, LOCAL_HOME)).toBe('/Users/me/orca/projects')
  })
})
