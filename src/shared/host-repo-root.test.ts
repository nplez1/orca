import { describe, expect, it } from 'vitest'
import { getDefaultRepoRootConvention, resolveCheckoutParent } from './host-repo-root'

describe('getDefaultRepoRootConvention', () => {
  it('is the worktree root under a nested layout, which is why the two settings coincide there', () => {
    expect(getDefaultRepoRootConvention('/Users/me', 'repo-nested')).toBe(
      '/Users/me/orca/workspaces'
    )
  })

  it('is <home>/orca/projects under a flat layout', () => {
    expect(getDefaultRepoRootConvention('/Users/me', 'flat')).toBe('/Users/me/orca/projects')
  })

  it('keeps a Windows separator', () => {
    expect(getDefaultRepoRootConvention('C:\\Users\\me', 'flat')).toBe(
      'C:\\Users\\me\\orca\\projects'
    )
  })

  it('is empty without a home', () => {
    expect(getDefaultRepoRootConvention('  ')).toBe('')
  })
})

describe('resolveCheckoutParent', () => {
  it('uses a stored repo root in every layout, ignoring the worktree root', () => {
    for (const layoutMode of ['flat', 'repo-nested', 'project-folder'] as const) {
      expect(
        resolveCheckoutParent({
          storedRepoRoot: '/data/checkouts',
          storedWorktreeRoot: '/srv/wt',
          layoutMode,
          hostHome: '/Users/me'
        })
      ).toBe('/data/checkouts')
    }
  })

  it('uses the stored worktree root as the container under a nested layout', () => {
    expect(
      resolveCheckoutParent({
        storedWorktreeRoot: '/srv/orca/workspaces',
        layoutMode: 'project-folder',
        hostHome: '/Users/me'
      })
    ).toBe('/srv/orca/workspaces')
  })

  it('moves Orca’s own workspaces tree to its sibling projects folder under flat', () => {
    expect(
      resolveCheckoutParent({
        storedWorktreeRoot: '/Users/me/orca/workspaces',
        layoutMode: 'flat',
        hostHome: '/Users/me'
      })
    ).toBe('/Users/me/orca/projects')
    expect(
      resolveCheckoutParent({
        storedWorktreeRoot: 'C:\\Users\\me\\orca\\workspaces',
        layoutMode: 'flat'
      })
    ).toBe('C:\\Users\\me\\orca\\projects')
  })

  it('keeps a worktree root the user named under flat', () => {
    expect(resolveCheckoutParent({ storedWorktreeRoot: '/srv/wt', layoutMode: 'flat' })).toBe(
      '/srv/wt'
    )
  })

  it('leaves a folder that only ends in workspaces alone under flat', () => {
    expect(
      resolveCheckoutParent({ storedWorktreeRoot: '/data/workspaces', layoutMode: 'flat' })
    ).toBe('/data/workspaces')
  })

  it('folds case only on Windows roots, where a hand-typed tree is still Orca’s own', () => {
    expect(
      resolveCheckoutParent({
        storedWorktreeRoot: 'C:\\Users\\me\\Orca\\Workspaces',
        layoutMode: 'flat'
      })
    ).toBe('C:\\Users\\me\\Orca\\projects')
    expect(
      resolveCheckoutParent({ storedWorktreeRoot: '~\\Orca\\Workspaces', layoutMode: 'flat' })
    ).toBe('~\\Orca\\projects')
    expect(
      resolveCheckoutParent({ storedWorktreeRoot: '/data/Orca/Workspaces', layoutMode: 'flat' })
    ).toBe('/data/Orca/Workspaces')
  })

  it('falls back to the convention for the host home', () => {
    expect(resolveCheckoutParent({ layoutMode: 'flat', hostHome: '/home/a' })).toBe(
      '/home/a/orca/projects'
    )
    expect(resolveCheckoutParent({ layoutMode: 'repo-nested', hostHome: '/home/a' })).toBe(
      '/home/a/orca/workspaces'
    )
  })

  it('is empty when nothing is stored and no home is known', () => {
    expect(resolveCheckoutParent({ layoutMode: 'flat' })).toBe('')
    expect(resolveCheckoutParent({ storedRepoRoot: '  ', storedWorktreeRoot: ' ' })).toBe('')
  })
})
