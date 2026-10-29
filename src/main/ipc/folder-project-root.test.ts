import { describe, expect, it } from 'vitest'
import { isFolderProjectRoot } from './folder-project-root'

const store = (overrides: {
  repos?: { path: string; kind: 'git' | 'folder' }[]
  folderWorkspaces?: { folderPath: string }[]
  projectGroups?: { parentPath: string | null }[]
}) => ({
  getRepos: () => overrides.repos ?? [],
  getFolderWorkspaces: () => overrides.folderWorkspaces ?? [],
  getProjectGroups: () => overrides.projectGroups ?? []
})

describe('isFolderProjectRoot', () => {
  it('is true for a folder workspace root', () => {
    expect(
      isFolderProjectRoot(
        store({ folderWorkspaces: [{ folderPath: '/code/notes' }] }),
        '/code/notes'
      )
    ).toBe(true)
  })

  it('is true for a repo row of kind folder', () => {
    expect(
      isFolderProjectRoot(
        store({ repos: [{ path: '/code/notes', kind: 'folder' }] }),
        '/code/notes'
      )
    ).toBe(true)
  })

  it('is true for a project group folder', () => {
    expect(
      isFolderProjectRoot(
        store({ projectGroups: [{ parentPath: '/code/platform' }] }),
        '/code/platform'
      )
    ).toBe(true)
  })

  it('is false for a git checkout, which owns its own ignore rules', () => {
    expect(
      isFolderProjectRoot(
        store({
          repos: [{ path: '/code/orca', kind: 'git' }],
          folderWorkspaces: [{ folderPath: '/code/notes' }]
        }),
        '/code/orca'
      )
    ).toBe(false)
  })

  it('is false for an untracked directory that belongs to no workspace', () => {
    expect(isFolderProjectRoot(store({}), '/code/scratch')).toBe(false)
  })

  it('matches the authorized spelling of a symlinked root', () => {
    const root = store({ folderWorkspaces: [{ folderPath: '/private/code/notes' }] })
    expect(isFolderProjectRoot(root, '/code/notes', '/private/code/notes')).toBe(true)
  })

  it('drops a trailing separator rather than missing the row', () => {
    expect(
      isFolderProjectRoot(
        store({ folderWorkspaces: [{ folderPath: '/code/notes' }] }),
        '/code/notes/'
      )
    ).toBe(true)
  })

  it('treats a store that cannot list workspaces as an ordinary checkout', () => {
    expect(isFolderProjectRoot({ getRepos: () => [] }, '/code/notes')).toBe(false)
  })
})
