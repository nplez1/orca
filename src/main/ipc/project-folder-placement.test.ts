import { posix } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  computeWorktreePath,
  computeWorkspaceRoot,
  getWorktreeCreationLayout,
  getWorktreePathSettings
} from './worktree-logic'

// Placement for the project-folder mode lives in ./project-folder-placement; these cover it
// through the public placement API the rest of the app calls.
describe('project-folder layout', () => {
  const settings = {
    nestWorkspaces: true,
    workspaceDir: '/workspaces',
    worktreeLayoutMode: 'project-folder' as const
  }
  const makeRepo = (
    overrides: {
      path?: string
      displayName?: string
      worktreeBasePath?: string
    } = {}
  ): { path: string; displayName: string; worktreeBasePath?: string } => ({
    path: '/projects/orca/main',
    displayName: 'orca',
    ...overrides
  })

  it('places worktrees in a container named after the repo display name', () => {
    const repo = makeRepo()
    expect(computeWorktreePath('feature', repo.path, getWorktreePathSettings(repo, settings))).toBe(
      posix.join('/workspaces', 'orca', 'feature')
    )
  })

  it('makes the container the workspace root, so a worktree is a sibling of the primary checkout', () => {
    // Why the container comes from displayName rather than basename(repoPath): the checkout's own
    // folder is the branch it was created for, so a path-derived container would be `main` for
    // every project and collapse them into one folder.
    const repo = makeRepo()
    const pathSettings = getWorktreePathSettings(repo, settings)
    expect(computeWorkspaceRoot(repo.path, pathSettings)).toBe(posix.join('/workspaces', 'orca'))
    expect(computeWorktreePath('feature', repo.path, pathSettings)).toBe(
      posix.join('/workspaces', 'orca', 'feature')
    )
  })

  it('sanitizes the display name into the container leaf', () => {
    const repo = makeRepo({ path: '/projects/my-project/main', displayName: 'My Project' })
    expect(computeWorktreePath('feature', repo.path, getWorktreePathSettings(repo, settings))).toBe(
      posix.join('/workspaces', 'My-Project', 'feature')
    )
  })

  it('falls back to the checkout folder when the display name has nothing usable left', () => {
    const repo = makeRepo({ displayName: '---' })
    expect(computeWorktreePath('feature', repo.path, getWorktreePathSettings(repo, settings))).toBe(
      posix.join('/workspaces', 'main', 'feature')
    )
  })

  it('nests the container one level below an explicit repo base path', () => {
    const repo = makeRepo({ worktreeBasePath: '/bases' })
    expect(computeWorktreePath('feature', repo.path, getWorktreePathSettings(repo, settings))).toBe(
      posix.join('/bases', 'orca', 'feature')
    )
  })

  it('records the mode on the creation layout', () => {
    expect(getWorktreeCreationLayout(makeRepo(), settings)).toEqual({
      path: '/workspaces',
      nestWorkspaces: true,
      worktreeLayoutMode: 'project-folder'
    })
  })

  it('recognises a container already named after the project at the checkout parent', () => {
    // The hand-built shape: <container>/<branch> with the base pointing at the container itself.
    // Adopting it keeps the checkout and its worktrees siblings instead of nesting again.
    const repo = makeRepo({
      path: '/Code/orca/main',
      displayName: 'orca',
      worktreeBasePath: '/Code/orca'
    })
    const pathSettings = getWorktreePathSettings(repo, settings)
    expect(computeWorkspaceRoot(repo.path, pathSettings)).toBe('/Code/orca')
    expect(computeWorktreePath('feature', repo.path, pathSettings)).toBe('/Code/orca/feature')
  })

  it("treats a relative root as this repo's own folder", () => {
    // A relative root resolves against each repo's path, so it is repo-scoped in effect: `..`
    // points at the container itself and must be adopted, not nested inside.
    const repo = makeRepo({
      path: '/code/foo/main',
      displayName: 'foo',
      worktreeBasePath: undefined
    })
    const pathSettings = getWorktreePathSettings(repo, {
      ...settings,
      workspaceDir: '..'
    })

    expect(computeWorkspaceRoot(repo.path, pathSettings)).toBe('/code/foo')
    expect(computeWorktreePath('feature', repo.path, pathSettings)).toBe('/code/foo/feature')
  })

  it('does not hand a project the shared root just because the root carries its name', () => {
    // Why: `workspaceDir` may legitimately be `~/orca` while a project is also named `orca`.
    // Adopting the root as that project's folder would put its worktrees beside every other
    // project's folders, so only a repo-scoped base is trusted.
    const repo = makeRepo({ path: '/Users/me/orca/main', displayName: 'orca' })
    const pathSettings = getWorktreePathSettings(repo, {
      ...settings,
      workspaceDir: '/Users/me/orca'
    })

    expect(computeWorkspaceRoot(repo.path, pathSettings)).toBe('/Users/me/orca/orca')
  })

  it('adds the container when the base is the container parent', () => {
    const repo = makeRepo({
      path: '/Code/orca/main',
      displayName: 'orca',
      worktreeBasePath: '/Code'
    })
    expect(computeWorktreePath('feature', repo.path, getWorktreePathSettings(repo, settings))).toBe(
      '/Code/orca/feature'
    )
  })

  it('recognises a base that is already a folder named after the project', () => {
    // The checkout can sit outside the base entirely: the base is still this project's own
    // folder, so a second container below it would be one nesting too many.
    const repo = makeRepo({
      path: '/Code/homelab',
      displayName: 'homelab',
      worktreeBasePath: '/orca/workspaces/homelab'
    })
    const pathSettings = getWorktreePathSettings(repo, settings)
    expect(computeWorkspaceRoot(repo.path, pathSettings)).toBe('/orca/workspaces/homelab')
    expect(computeWorktreePath('feature', repo.path, pathSettings)).toBe(
      '/orca/workspaces/homelab/feature'
    )
  })

  it('keeps worktrees out of the working tree when the base is the checkout parent', () => {
    // Degenerate config: the base is the checkout's parent and the project name matches the
    // checkout's own folder, so the container would be the checkout itself. Git would create a
    // worktree inside the working tree without complaint, so placement must not ask it to.
    const repo = makeRepo({
      path: '/Code/homelab',
      displayName: 'homelab',
      worktreeBasePath: '/Code'
    })
    const pathSettings = getWorktreePathSettings(repo, settings)
    expect(computeWorkspaceRoot(repo.path, pathSettings)).toBe('/Code')
    expect(computeWorktreePath('feature', repo.path, pathSettings)).toBe('/Code/feature')
  })

  it('leaves the layout clone and create produce alone', () => {
    const repo = makeRepo({ path: '/workspaces/orca/main', displayName: 'orca' })
    const pathSettings = getWorktreePathSettings(repo, { ...settings, workspaceDir: '/workspaces' })
    expect(computeWorkspaceRoot(repo.path, pathSettings)).toBe('/workspaces/orca')
    expect(computeWorktreePath('feature', repo.path, pathSettings)).toBe('/workspaces/orca/feature')
  })

  it('reads a settings object carrying no mode through the legacy boolean', () => {
    expect(
      computeWorktreePath('feature', '/projects/app/repo', {
        nestWorkspaces: true,
        workspaceDir: '/workspaces'
      })
    ).toBe(posix.join('/workspaces', 'repo', 'feature'))
    expect(
      computeWorktreePath('feature', '/projects/app/repo', {
        nestWorkspaces: false,
        workspaceDir: '/workspaces'
      })
    ).toBe(posix.join('/workspaces', 'feature'))
  })
})
