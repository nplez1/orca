import { describe, expect, it } from 'vitest'
import {
  buildWorkspaceDirHistoryForUpdate,
  migrateAgentYoloDefaults
} from './terminal-settings-migrations'

describe('migrateAgentYoloDefaults', () => {
  it('keeps newly added agent defaults manual for already migrated profiles', () => {
    const migrated = migrateAgentYoloDefaults({
      agentYoloDefaultsMigrated: true,
      agentDefaultArgs: { claude: '--dangerously-skip-permissions' },
      agentDefaultEnv: {}
    } as never)

    expect(migrated.agentDefaultArgs?.droid).toBe('')
    expect(migrated.agentDefaultEnv?.goose).toEqual({})
  })

  it('updates the previous Devin default for existing profiles', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This test only supplies the settings fields consumed by this migration.
    const migrated = migrateAgentYoloDefaults({
      agentYoloDefaultsMigrated: true,
      agentDefaultArgs: { devin: '--permission-mode bypass' },
      agentDefaultEnv: {}
    } as never)

    expect(migrated.agentDefaultArgs?.devin).toBe(
      '--permission-mode bypass --respect-workspace-trust false'
    )
  })
})

describe('buildWorkspaceDirHistoryForUpdate', () => {
  const current = (overrides: Record<string, unknown> = {}) =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this test supplies only the fields the migration reads.
    ({
      workspaceDir: '/orca/workspaces',
      nestWorkspaces: true,
      worktreeLayoutMode: 'repo-nested',
      workspaceDirHistory: [],
      ...overrides
    }) as never

  it('records the previous layout with the mode it was using when only the mode changes', () => {
    expect(
      buildWorkspaceDirHistoryForUpdate(current(), {
        worktreeLayoutMode: 'project-folder',
        nestWorkspaces: true
      })
    ).toEqual([
      { path: '/orca/workspaces', nestWorkspaces: true, worktreeLayoutMode: 'repo-nested' }
    ])
  })

  it('records nothing when no placement-relevant value changed', () => {
    expect(
      buildWorkspaceDirHistoryForUpdate(current(), { worktreeLayoutMode: 'repo-nested' })
    ).toBeNull()
  })

  it('keeps a mode recorded earlier distinct from the mode now in effect', () => {
    const settings = current({
      worktreeLayoutMode: 'project-folder',
      workspaceDirHistory: [
        { path: '/old/ws', nestWorkspaces: true, worktreeLayoutMode: 'repo-nested' }
      ]
    })

    expect(buildWorkspaceDirHistoryForUpdate(settings, { workspaceDir: '/new/ws' })).toEqual([
      { path: '/old/ws', nestWorkspaces: true, worktreeLayoutMode: 'repo-nested' },
      { path: '/orca/workspaces', nestWorkspaces: true, worktreeLayoutMode: 'project-folder' }
    ])
  })
})
