import { describe, expect, it } from 'vitest'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  toSshExecutionHostId
} from '../../../../../../shared/execution-host'
import {
  getCloneDestinationAutoFill,
  getCloneParentForHost,
  needsHostHomeProbe
} from './clone-defaults'

const LOCAL = LOCAL_EXECUTION_HOST_ID
const SERVER = toRuntimeExecutionHostId('server-a')
const SSH = toSshExecutionHostId('builder')

describe('getCloneParentForHost', () => {
  it('uses this computer’s workspace dir under a nested layout', () => {
    expect(
      getCloneParentForHost({
        settings: { workspaceDir: '/Users/me/orca/workspaces' },
        hostIds: [LOCAL],
        layoutMode: 'repo-nested'
      })
    ).toBe('/Users/me/orca/workspaces')
  })

  it('places a flat-layout clone in the projects tree beside the workspaces one', () => {
    expect(
      getCloneParentForHost({
        settings: { workspaceDir: '/Users/me/orca/workspaces' },
        hostIds: [LOCAL],
        layoutMode: 'flat'
      })
    ).toBe('/Users/me/orca/projects')
  })

  it('keeps a worktree root the user named under a flat layout', () => {
    expect(
      getCloneParentForHost({
        settings: { hostSettingOverrides: { [SERVER]: { defaultWorktreeLocation: '/srv/wt' } } },
        hostIds: [SERVER],
        layoutMode: 'flat'
      })
    ).toBe('/srv/wt')
  })

  it('keeps a folder that only ends in workspaces, so a checkout never lands beside it', () => {
    expect(
      getCloneParentForHost({
        settings: { workspaceDir: '/data/workspaces' },
        hostIds: [LOCAL],
        layoutMode: 'flat'
      })
    ).toBe('/data/workspaces')
  })

  it('prefers the host’s stored checkout root', () => {
    expect(
      getCloneParentForHost({
        settings: {
          workspaceDir: '/Users/me/orca/workspaces',
          hostSettingOverrides: { [SERVER]: { defaultRepoRoot: '/srv/src' } }
        },
        hostIds: [SERVER],
        layoutMode: 'project-folder'
      })
    ).toBe('/srv/src')
  })

  it('derives a remote default from that host’s own worktree root', () => {
    expect(
      getCloneParentForHost({
        settings: {
          hostSettingOverrides: {
            [SERVER]: { defaultWorktreeLocation: '/home/me/orca/workspaces' }
          }
        },
        hostIds: [SERVER],
        layoutMode: 'project-folder'
      })
    ).toBe('/home/me/orca/workspaces')
  })

  it('never hands a remote host this computer’s workspaceDir', () => {
    expect(
      getCloneParentForHost({
        settings: { workspaceDir: '/Users/me/orca/workspaces' },
        hostIds: [SERVER],
        layoutMode: 'repo-nested'
      })
    ).toBe('')
  })

  it('falls back to the probed home convention for a remote host', () => {
    expect(
      getCloneParentForHost({
        settings: { workspaceDir: '/Users/me/orca/workspaces' },
        hostIds: [SERVER],
        layoutMode: 'repo-nested',
        hostHome: '/home/me'
      })
    ).toBe('/home/me/orca/workspaces')
  })

  it('never offers a destination on an SSH host, which cannot clone', () => {
    expect(
      getCloneParentForHost({
        settings: {
          hostSettingOverrides: { [SSH]: { defaultWorktreeLocation: '/srv/orca' } }
        },
        hostIds: [SSH],
        layoutMode: 'repo-nested'
      })
    ).toBe('')
  })

  it('never offers a destination derived from a relative workspace dir', () => {
    expect(
      getCloneParentForHost({
        settings: { workspaceDir: '.orca/worktrees' },
        hostIds: [LOCAL],
        layoutMode: 'repo-nested'
      })
    ).toBe('')
  })

  it('keeps a home-prefixed root for the host’s own process to expand', () => {
    expect(
      getCloneParentForHost({
        settings: { hostSettingOverrides: { [SERVER]: { defaultRepoRoot: '~/src' } } },
        hostIds: [SERVER],
        layoutMode: 'repo-nested'
      })
    ).toBe('~/src')
  })

  it('ignores a relative root and falls back to the host’s convention', () => {
    expect(
      getCloneParentForHost({
        settings: { hostSettingOverrides: { [SERVER]: { defaultRepoRoot: 'src' } } },
        hostIds: [SERVER],
        layoutMode: 'repo-nested',
        hostHome: '/home/me'
      })
    ).toBe('/home/me/orca/workspaces')
  })
})

describe('needsHostHomeProbe', () => {
  it('probes a runtime host whose stored root cannot name a folder', () => {
    expect(
      needsHostHomeProbe({ hostSettingOverrides: { [SERVER]: { defaultRepoRoot: 'src' } } }, [
        SERVER
      ])
    ).toEqual({ environmentId: 'server-a', probe: true })
  })

  it('skips the probe when the stored root is usable as stored', () => {
    expect(
      needsHostHomeProbe({ hostSettingOverrides: { [SERVER]: { defaultRepoRoot: '~/src' } } }, [
        SERVER
      ])
    ).toEqual({ environmentId: 'server-a', probe: false })
  })
})

describe('getCloneDestinationAutoFill', () => {
  it('fills an empty destination once', () => {
    expect(
      getCloneDestinationAutoFill({
        step: 'clone',
        cloneDestination: '',
        cloneStepAutoFilled: false,
        parent: '/srv/src'
      })
    ).toEqual({ destination: '/srv/src' })
  })

  it('never overwrites what the user typed', () => {
    expect(
      getCloneDestinationAutoFill({
        step: 'clone',
        cloneDestination: '/typed',
        cloneStepAutoFilled: false,
        parent: '/srv/src'
      })
    ).toBeNull()
  })

  it('fills once per visit to the clone step', () => {
    expect(
      getCloneDestinationAutoFill({
        step: 'clone',
        cloneDestination: '',
        cloneStepAutoFilled: true,
        parent: '/srv/src'
      })
    ).toBeNull()
  })

  it('waits while the host’s default is still unknown', () => {
    expect(
      getCloneDestinationAutoFill({
        step: 'clone',
        cloneDestination: '',
        cloneStepAutoFilled: false,
        parent: ''
      })
    ).toBeNull()
  })
})
