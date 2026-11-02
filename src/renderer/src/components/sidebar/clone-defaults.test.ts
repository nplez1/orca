import { describe, expect, it } from 'vitest'
import { getCloneDestinationAutoFill, getDefaultCloneParent } from './clone-defaults'

describe('getCloneDestinationAutoFill project-folder layout', () => {
  it('auto-fills the workspace dir so the checkout lands inside its project folder', () => {
    expect(
      getCloneDestinationAutoFill({
        step: 'clone',
        cloneDestination: '',
        activeRuntimeEnvironmentId: null,
        workspaceDir: '/Users/mvanhorn/orca/workspaces',
        layoutMode: 'project-folder',
        cloneStepAutoFilled: false
      })
    ).toEqual({ destination: '/Users/mvanhorn/orca/workspaces' })
  })
})

describe('getCloneDestinationAutoFill nested layouts', () => {
  it('auto-fills the workspace dir under Nest Workspaces too', () => {
    // Why: the checkout now lands at <workspaceDir>/<project>/<branch>, so the destination has to
    // be the root its worktrees are placed under rather than the folder above it.
    expect(
      getCloneDestinationAutoFill({
        step: 'clone',
        cloneDestination: '',
        activeRuntimeEnvironmentId: null,
        workspaceDir: '/Users/mvanhorn/orca/workspaces',
        layoutMode: 'repo-nested',
        cloneStepAutoFilled: false
      })
    ).toEqual({ destination: '/Users/mvanhorn/orca/workspaces' })
  })
})

describe('getDefaultCloneParent', () => {
  it('returns the drive root for a Windows root workspaces path', () => {
    expect(getDefaultCloneParent('C:\\workspaces', 'flat')).toBe('C:\\')
  })

  it('strips repeated trailing separators before matching the suffix', () => {
    expect(getDefaultCloneParent('D:\\orca\\workspaces\\\\', 'flat')).toBe('D:\\orca')
  })

  it('does not strip a similar-looking final segment', () => {
    expect(getDefaultCloneParent('/Users/mvanhorn/orca/project-workspaces', 'flat')).toBe(
      '/Users/mvanhorn/orca/project-workspaces'
    )
  })

  it('keeps the workspace dir itself under every nested layout', () => {
    // Why: the clone path appends <project>/<branch> itself, so stripping the trailing segment
    // would land the checkout outside the root the worktrees are placed under.
    for (const layoutMode of ['project-folder', 'repo-nested'] as const) {
      expect(getDefaultCloneParent('/Users/mvanhorn/orca/workspaces', layoutMode)).toBe(
        '/Users/mvanhorn/orca/workspaces'
      )
    }
  })
})

describe('getCloneDestinationAutoFill', () => {
  it('does not overwrite typed destinations or repeat an auto-fill', () => {
    expect(
      getCloneDestinationAutoFill({
        step: 'clone',
        cloneDestination: '/tmp/project',
        activeRuntimeEnvironmentId: null,
        workspaceDir: '/Users/mvanhorn/orca/workspaces',
        cloneStepAutoFilled: false
      })
    ).toBeNull()
    expect(
      getCloneDestinationAutoFill({
        step: 'clone',
        cloneDestination: '',
        activeRuntimeEnvironmentId: null,
        workspaceDir: '/Users/mvanhorn/orca/workspaces',
        cloneStepAutoFilled: true
      })
    ).toBeNull()
  })

  it('does not fill server clone destinations for runtime environments', () => {
    expect(
      getCloneDestinationAutoFill({
        step: 'clone',
        cloneDestination: '',
        activeRuntimeEnvironmentId: 'env-local-linux',
        workspaceDir: '/Users/mvanhorn/orca/workspaces',
        cloneStepAutoFilled: false
      })
    ).toBeNull()
  })
})
