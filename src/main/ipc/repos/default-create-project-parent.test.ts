import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getDefaultSettings, getDefaultWorkspaceDir } from '../../../shared/constants'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { resolveDefaultCreateProjectParent } from './default-create-project-parent'

const HOME = '/home/me'
const NESTED = getDefaultWorkspaceDir(HOME)

function settings(overrides: Partial<GlobalSettings> = {}): GlobalSettings {
  return {
    ...getDefaultSettings(HOME),
    nestWorkspaces: true,
    worktreeLayoutMode: 'repo-nested',
    ...overrides
  }
}

describe('resolveDefaultCreateProjectParent', () => {
  it('returns a stored checkout root unchanged', () => {
    expect(
      resolveDefaultCreateProjectParent(
        settings({
          hostSettingOverrides: {
            [LOCAL_EXECUTION_HOST_ID]: { defaultRepoRoot: '/data/checkouts' }
          }
        }),
        HOME
      )
    ).toBe('/data/checkouts')
  })

  it('expands a home-prefixed checkout root against this machine’s home', () => {
    expect(
      resolveDefaultCreateProjectParent(
        settings({
          hostSettingOverrides: {
            [LOCAL_EXECUTION_HOST_ID]: { defaultRepoRoot: '~/src' }
          }
        }),
        HOME
      )
    ).toBe('/home/me/src')
  })

  it('ignores a relative checkout root, which cannot name a create parent', () => {
    expect(
      resolveDefaultCreateProjectParent(
        settings({
          hostSettingOverrides: { [LOCAL_EXECUTION_HOST_ID]: { defaultRepoRoot: 'src' } }
        }),
        HOME
      )
    ).toBe(NESTED)
  })

  it('falls back to the layout convention for a relative workspace folder', () => {
    expect(
      resolveDefaultCreateProjectParent(settings({ workspaceDir: '.orca/worktrees' }), HOME)
    ).toBe(NESTED)
  })

  it('expands a home-prefixed workspace folder under a nested layout', () => {
    expect(resolveDefaultCreateProjectParent(settings({ workspaceDir: '~/orca/wt' }), HOME)).toBe(
      join(HOME, 'orca', 'wt')
    )
  })

  it('places a flat-layout project beside the workspace tree', () => {
    expect(
      resolveDefaultCreateProjectParent(
        settings({ worktreeLayoutMode: 'flat', nestWorkspaces: false }),
        HOME
      )
    ).toBe(join(HOME, 'orca', 'projects'))
  })
})
