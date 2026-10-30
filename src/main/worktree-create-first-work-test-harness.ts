import { vi, type Mock } from 'vitest'
import type { CreateWorktreeArgs } from '../shared/worktree/create-types'
import type { Worktree } from '../shared/worktree/types'
import type { WorktreeMeta } from '../shared/worktree/meta-types'
import { getDefaultSettings } from '../shared/constants'
import { firstWorkRenameDeps } from './agent-hooks/first-work-rename-runtime'
import {
  maybeAutoRenameBranchOnFirstWork,
  resetFirstWorkBranchRenameState
} from './agent-hooks/first-work-branch-rename'
import { gitResponder, workingEvent } from './agent-hooks/first-work-branch-rename-test-harness'
import { mergeWorktree } from './ipc/worktree-metadata-merge'

export type LabelOnlyCreateRequest = Pick<
  CreateWorktreeArgs,
  'name' | 'displayName' | 'displayNameKind' | 'nameWasGenerated'
>

/** Each row pins the branch a create lands on and whether first-work naming may replace it. */
export const labelOnlyCreateCases: {
  request: LabelOnlyCreateRequest
  branch: string
  /** True only when Orca generated the name, so the branch is Orca's to rename. */
  renamedOnFirstWork: boolean
}[] = [
  {
    request: { name: '認証を修正', displayName: '認証を修正', displayNameKind: 'user' },
    branch: '認証を修正',
    renamedOnFirstWork: false
  },
  {
    request: { name: 'fix-authentication', displayNameKind: 'user' },
    branch: 'fix-authentication',
    renamedOnFirstWork: false
  },
  {
    // The dialog's own input: a label with a slash and a space must reach the branch sanitized.
    request: {
      name: 'Branch/Workspace Naming',
      displayName: 'Branch/Workspace Naming',
      displayNameKind: 'user'
    },
    branch: 'Branch-Workspace-Naming',
    renamedOnFirstWork: false
  },
  {
    // A typed creature word is the user's name, not an Orca placeholder.
    request: { name: 'nautilus', displayNameKind: 'user' },
    branch: 'nautilus',
    renamedOnFirstWork: false
  },
  {
    request: { name: 'nautilus', nameWasGenerated: true },
    branch: 'nautilus',
    renamedOnFirstWork: true
  }
]

export const generatedNameCreateRequest: Pick<CreateWorktreeArgs, 'name' | 'nameWasGenerated'> = {
  name: 'nautilus',
  nameWasGenerated: true
}

export type FirstWorkRenameOutcome = {
  /** Post-attempt worktree, merged with whatever meta the rename wrote. */
  worktree: Worktree
  /** True when first-work naming replaced the branch. */
  renamed: boolean
}

export async function renameCreatedWorktreeOnFirstWork(
  worktree: Worktree,
  initialMeta: Partial<WorktreeMeta>,
  gitMock: Mock
): Promise<FirstWorkRenameOutcome> {
  resetFirstWorkBranchRenameState()
  let meta: WorktreeMeta = {
    displayName: '',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...initialMeta
  }
  let branch = worktree.branch.replace(/^refs\/heads\//, '')
  const respond = gitResponder({ currentBranch: branch, hasUpstream: false })
  gitMock.mockImplementation(async (args: string[]) => {
    if (args[0] === 'branch' && args[1] === '-m') {
      branch = args[2]
    }
    return respond(args)
  })
  const repo = {
    id: worktree.repoId,
    path: '/repo',
    displayName: 'Repo',
    badgeColor: '',
    addedAt: 0
  }
  const notifyBranchRenamed = vi.fn()
  const deps = firstWorkRenameDeps(
    {
      getSettings: () => ({
        ...getDefaultSettings('/tmp/pr-32919-fixture'),
        autoRenameBranchFromWork: true,
        branchPrefix: 'none'
      }),
      getRepo: () => repo,
      getRepos: () => [repo],
      getWorktreeMeta: () => meta,
      setWorktreeMeta: (_target, updates) => (meta = { ...meta, ...updates }),
      getFolderWorkspace: () => undefined,
      updateFolderWorkspace: () => null,
      getWorktreeIdForTab: () => worktree.id
    },
    {
      getCommitMessageAgentEnvironmentResolvers: () => undefined,
      notifyFolderWorkspaceChanged: vi.fn(),
      notifyBranchRenamed,
      notifyWorktreeFolderRenamed: vi.fn()
    }
  )
  await maybeAutoRenameBranchOnFirstWork(workingEvent({ worktreeId: worktree.id }), deps)
  const renamed = notifyBranchRenamed.mock.calls.length > 0
  return {
    worktree: mergeWorktree(worktree.repoId, { ...worktree, branch: `refs/heads/${branch}` }, meta),
    renamed
  }
}
