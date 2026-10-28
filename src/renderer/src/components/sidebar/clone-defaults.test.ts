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

describe('getDefaultCloneParent', () => {
  it('returns the drive root for a Windows root workspaces path', () => {
    expect(getDefaultCloneParent('C:\\workspaces')).toBe('C:\\')
  })

  it('strips repeated trailing separators before matching the suffix', () => {
    expect(getDefaultCloneParent('D:\\orca\\workspaces\\\\')).toBe('D:\\orca')
  })

  it('does not strip a similar-looking final segment', () => {
    expect(getDefaultCloneParent('/Users/mvanhorn/orca/project-workspaces')).toBe(
      '/Users/mvanhorn/orca/project-workspaces'
    )
  })

  it('keeps the workspace dir itself under the project-folder layout', () => {
    // Why: the clone path appends <project>/<branch> itself, so stripping the trailing segment
    // would land the checkout outside the root the worktrees are placed under.
    expect(getDefaultCloneParent('/Users/mvanhorn/orca/workspaces', 'project-folder')).toBe(
      '/Users/mvanhorn/orca/workspaces'
    )
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
