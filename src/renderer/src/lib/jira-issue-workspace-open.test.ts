import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { Worktree } from '../../../shared/worktree/types'

const mocks = vi.hoisted(() => {
  const folderWorkspaces: FolderWorkspace[] = []
  const worktrees: Worktree[] = []
  return {
    activateAndRevealFolderWorkspace: vi.fn(),
    activateAndRevealWorktree: vi.fn(),
    folderWorkspaces,
    worktrees
  }
})

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      allWorktrees: () => mocks.worktrees,
      folderWorkspaces: mocks.folderWorkspaces
    })
  }
}))
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealFolderWorkspace: mocks.activateAndRevealFolderWorkspace,
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

import { openJiraIssueWorkspaceOrStart } from './jira-issue-workspace-open'

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'worktree-1',
    repoId: 'repo-1',
    path: '/repo/worktree-1',
    head: 'abc',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false,
    displayName: 'Worktree',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedWorkItem: {
      provider: 'jira',
      type: 'issue',
      number: 0,
      title: 'ALP-1',
      url: 'https://acme.atlassian.net/browse/ALP-1',
      jiraIdentifier: 'ALP-1'
    },
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

function folderWorkspace(): FolderWorkspace {
  return {
    id: 'folder-1',
    projectGroupId: 'group-1',
    name: 'Folder workspace',
    folderPath: '/repo/folder-1',
    linkedTask: {
      provider: 'jira',
      type: 'issue',
      number: 0,
      title: 'ALP-1',
      url: 'https://acme.atlassian.net/browse/ALP-1',
      jiraIdentifier: 'ALP-1'
    },
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0
  }
}

const ALP_1 = { key: 'ALP-1', url: 'https://acme.atlassian.net/browse/ALP-1' }

describe('openJiraIssueWorkspaceOrStart', () => {
  beforeEach(() => {
    mocks.worktrees = []
    mocks.folderWorkspaces = []
    mocks.activateAndRevealFolderWorkspace.mockReset().mockReturnValue({ primaryTabId: null })
    mocks.activateAndRevealWorktree.mockReset().mockReturnValue({ primaryTabId: null })
  })

  it('qualifies remote worktree activation with its execution host', () => {
    mocks.worktrees = [worktree({ hostId: 'ssh:builder' })]

    expect(openJiraIssueWorkspaceOrStart(ALP_1, vi.fn())).toBe('opened')
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('worktree-1', {
      navigationIntent: 'user-open',
      executionHostId: 'ssh:builder'
    })
  })

  it('opens a linked folder workspace instead of starting a duplicate', () => {
    mocks.folderWorkspaces = [folderWorkspace()]
    const startWorkspace = vi.fn()

    expect(openJiraIssueWorkspaceOrStart(ALP_1, startWorkspace)).toBe('opened')
    expect(mocks.activateAndRevealFolderWorkspace).toHaveBeenCalledWith('folder-1', {
      navigationIntent: 'user-open',
      executionHostId: 'local'
    })
    expect(startWorkspace).not.toHaveBeenCalled()
  })

  it('starts a workspace when the issue has none attached', () => {
    const startWorkspace = vi.fn()

    expect(openJiraIssueWorkspaceOrStart(ALP_1, startWorkspace)).toBe('started')
    expect(startWorkspace).toHaveBeenCalledTimes(1)
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('re-reads the live workspace list rather than a value captured earlier', () => {
    const startWorkspace = vi.fn()
    expect(openJiraIssueWorkspaceOrStart(ALP_1, startWorkspace)).toBe('started')

    // The workspace appears after the row that offered "Start workspace" rendered.
    mocks.worktrees = [worktree()]
    expect(openJiraIssueWorkspaceOrStart(ALP_1, startWorkspace)).toBe('opened')
    expect(startWorkspace).toHaveBeenCalledTimes(1)
  })

  it('reports failure when activation is refused', () => {
    mocks.worktrees = [worktree()]
    mocks.activateAndRevealWorktree.mockReturnValue(false)
    const startWorkspace = vi.fn()

    expect(openJiraIssueWorkspaceOrStart(ALP_1, startWorkspace)).toBe('failed')
    expect(startWorkspace).not.toHaveBeenCalled()
  })
})
