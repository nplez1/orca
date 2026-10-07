import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { LinearIssue } from '../../../../shared/linear/issue-types'
import type { Repo } from '../../../../shared/repo-types'
import type { JiraSite } from '../../../../shared/jira-types'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import type { WorktreeMetaUpdateOptions } from '@/store/slices/worktree-helpers'
import type { Worktree } from '../../../../shared/worktree/types'
import WorktreeMetaDialog from './WorktreeMetaDialog'

/** The dialog's test harness: fixtures, the real-store seeding `openDialog` does,
 *  and the per-test reset. Shared so a second suite on the same dialog cannot
 *  drift from this one (and so neither file outgrows the max-lines cap). */

export const REPO_ID = 'repo-1'
export const WORKTREE_ID = 'repo-1::/repo/worktrees/feature'

export const IME_FIELDS = [
  {
    placeholder: 'Notes about this worktree...',
    value: '日本語',
    updates: { comment: '日本語' }
  },
  {
    placeholder: 'Custom display name...',
    value: '日本語の名前',
    updates: { displayName: '日本語の名前' }
  },
  {
    placeholder: 'Issue #, key, or an issue URL',
    value: '42',
    updates: { linkedIssue: 42 }
  },
  { placeholder: 'PR # or GitHub URL', value: '43', updates: { linkedPR: 43 } },
  { placeholder: 'MR ! or GitLab URL', value: '!44', updates: { linkedGitLabMR: 44 } }
] as const

const initialState = useAppStore.getInitialState()
export const updateWorktreeMeta =
  vi.fn<
    (
      id: string,
      updates: Partial<WorktreeMeta>,
      options?: WorktreeMetaUpdateOptions
    ) => Promise<{ ok: true } | { ok: false; error: string }>
  >()
export const fetchLinearIssue = vi.fn<(...args: never[]) => Promise<LinearIssue | null>>()
export const openUrl = vi.fn<(url: string) => void>()

/** Only `url` is read by the open-issue path; the rest is filled so the fixture
 *  is a real `LinearIssue` rather than an assertion. */
export function makeLinearIssue(url: string): LinearIssue {
  return {
    id: 'issue-1',
    identifier: 'STA-335',
    title: 'Linear issue',
    url,
    state: { name: 'Todo', type: 'unstarted', color: '#999999' },
    team: { id: 'team-1', key: 'STA', name: 'Team' },
    labels: [],
    labelIds: [],
    priority: 0,
    updatedAt: '2026-09-02T00:00:00.000Z'
  }
}

export function makeRepo(id: string = REPO_ID, path: string = '/repo'): Repo {
  return { id, path, displayName: 'orca', badgeColor: '#999999', addedAt: 1 }
}

export function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: WORKTREE_ID,
    repoId: REPO_ID,
    path: '/repo/worktrees/feature',
    displayName: 'Feature work',
    branch: 'feature',
    head: 'abc123',
    isBare: false,
    isMainWorktree: false,
    comment: 'existing note',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    ...overrides
  }
}

export function makeFolderWorkspace(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: 'fw-1',
    projectGroupId: 'pg-1',
    name: 'Docs folder',
    folderPath: '/repo/docs',
    linkedTask: {
      provider: 'linear',
      type: 'issue',
      number: 901,
      title: 'Fix auth',
      url: 'https://linear.app/acme/issue/STA-901',
      linearIdentifier: 'STA-901'
    },
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

export function openDialog(
  options: {
    worktree?: Partial<Worktree>
    worktreeId?: string
    folderWorkspace?: Partial<FolderWorkspace>
    /** Extra owners of the same workspace ID, which the index reads as ambiguous. */
    otherRepos?: { repoId: string; worktree?: Partial<Worktree> }[]
    modalRepoId?: string
    modalExecutionHostId?: string
    modalReviewProvider?: 'github' | 'gitlab'
    modalCurrentReview?: number
    modalSuppressHostedReviewRefresh?: boolean
    linearViewerOrganizationUrlKey?: string
    /** Connected Jira sites plus the summary lookup the dialog resolves a key with. */
    jira?: {
      sites: JiraSite[]
      lookup: ReturnType<typeof useAppStore.getState>['lookupJiraIssueSummary']
    }
  } = {}
): void {
  const worktree = makeWorktree(options.worktree)
  const otherRepos = options.otherRepos ?? []
  useAppStore.setState({
    repos: [makeRepo(), ...otherRepos.map((other) => makeRepo(other.repoId, `/${other.repoId}`))],
    worktreesByRepo: {
      [REPO_ID]: [worktree],
      ...Object.fromEntries(
        otherRepos.map((other) => [
          other.repoId,
          [makeWorktree({ repoId: other.repoId, ...other.worktree })]
        ])
      )
    },
    ...(options.folderWorkspace
      ? { folderWorkspaces: [makeFolderWorkspace(options.folderWorkspace)] }
      : {}),
    ...(options.linearViewerOrganizationUrlKey
      ? {
          linearStatus: {
            connected: true,
            viewer: {
              displayName: 'Viewer',
              email: null,
              organizationName: 'Active',
              organizationUrlKey: options.linearViewerOrganizationUrlKey
            }
          },
          // Why: the provider menu only offers Linear while the connection status
          // belongs to the active runtime context; a stale key hides it.
          linearStatusContextKey: getProviderRuntimeContextKey(useAppStore.getState().settings)
        }
      : {}),
    ...(options.jira
      ? {
          jiraStatus: {
            connected: true,
            viewer: null,
            sites: options.jira.sites,
            selectedSiteId: options.jira.sites[0]?.id ?? null
          },
          jiraStatusChecked: true,
          // Why: the provider menu only offers Jira while the connection status
          // belongs to the active runtime context; a stale key hides it.
          jiraStatusContextKey: getProviderRuntimeContextKey(useAppStore.getState().settings),
          lookupJiraIssueSummary: options.jira.lookup
        }
      : {}),
    activeModal: 'edit-meta',
    modalData: {
      worktreeId: options.worktreeId ?? worktree.id,
      ...(options.modalRepoId ? { repoId: options.modalRepoId } : {}),
      ...(options.modalExecutionHostId ? { executionHostId: options.modalExecutionHostId } : {}),
      ...(options.modalReviewProvider ? { reviewProvider: options.modalReviewProvider } : {}),
      ...(options.modalCurrentReview ? { currentReview: options.modalCurrentReview } : {}),
      ...(options.modalSuppressHostedReviewRefresh ? { suppressHostedReviewRefresh: true } : {}),
      currentDisplayName: worktree.displayName,
      currentComment: worktree.comment,
      focus: 'comment'
    },
    updateWorktreeMeta,
    fetchLinearIssue: fetchLinearIssue as unknown as ReturnType<
      typeof useAppStore.getState
    >['fetchLinearIssue']
  })
  render(<WorktreeMetaDialog />)
}

export function issueInput(): HTMLInputElement {
  return screen.getByPlaceholderText('Issue #, key, or an issue URL')
}

export function providerChip(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Issue provider' })
}

export function saveButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Save' })
}

export function openIssueButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Open linked issue' })
}

/** Every suite that renders this dialog runs against the same real store, so the
 *  reset has to be installed per file and cover all of its describes. */
export function installWorktreeMetaDialogTestLifecycle(): void {
  beforeEach(() => {
    useAppStore.setState(initialState, true)
    updateWorktreeMeta.mockReset()
    updateWorktreeMeta.mockResolvedValue({ ok: true })
    fetchLinearIssue.mockReset()
    fetchLinearIssue.mockResolvedValue(null)
    openUrl.mockReset()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { shell: { openUrl } }
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    useAppStore.setState(initialState, true)
  })
}
