import { describe, expect, it } from 'vitest'
import { getDefaultRepoRootConvention } from './host-repo-root'

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
