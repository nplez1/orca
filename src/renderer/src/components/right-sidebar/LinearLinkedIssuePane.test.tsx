// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { LinearIssue } from '../../../../shared/linear/issue-types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type * as I18n from '@/i18n/i18n'
import { scopedLinearCacheKeyForSource } from '@/store/slices/linear/linear-slice-scope'
import { LinearLinkedIssuePane } from './LinearLinkedIssuePane'

/** The store's issue cache entry `fetchLinearIssue` writes, as the pane reads it. */
type CachedLinearIssue = { data: unknown; fetchedAt: number }

const mocks = vi.hoisted(
  (): {
    fetchLinearIssue: Mock
    linearGetIssue: Mock
    linearIssueComments: Mock
    linearUpdateIssue: Mock
    linearAddIssueComment: Mock
    patchLinearIssue: Mock
    linearIssueCache: Record<string, CachedLinearIssue>
    readTeamStates: Mock
  } => ({
    fetchLinearIssue: vi.fn(),
    linearGetIssue: vi.fn(),
    linearIssueComments: vi.fn(),
    linearUpdateIssue: vi.fn(),
    linearAddIssueComment: vi.fn(),
    patchLinearIssue: vi.fn(),
    linearIssueCache: {},
    readTeamStates: vi.fn()
  })
)

vi.mock('@/store', () => {
  const state = () => ({
    settings: null,
    linearIssueCache: mocks.linearIssueCache,
    linearStatus: { viewer: null },
    fetchLinearIssue: mocks.fetchLinearIssue,
    patchLinearIssue: mocks.patchLinearIssue,
    invalidateLinearIssueLists: vi.fn(),
    recordFeatureInteraction: vi.fn()
  })
  const useAppStore = (selector: (s: ReturnType<typeof state>) => unknown) => selector(state())
  useAppStore.getState = state
  return { useAppStore }
})

vi.mock('@/runtime/runtime-linear-issue-mutations', () => ({
  linearGetIssue: (...args: unknown[]) => mocks.linearGetIssue(...args),
  linearIssueComments: (...args: unknown[]) => mocks.linearIssueComments(...args),
  linearUpdateIssue: (...args: unknown[]) => mocks.linearUpdateIssue(...args),
  linearAddIssueComment: (...args: unknown[]) => mocks.linearAddIssueComment(...args)
}))

vi.mock('@/hooks/useIssueMetadata', () => ({
  useTeamStates: () => mocks.readTeamStates(),
  useTeamLabels: () => ({ data: [], loading: false, error: null }),
  useTeamMembers: () => ({ data: [], loading: false, error: null }),
  useImmediateMutation: () => ({
    isPending: () => false,
    run: (_kind: string, args: { mutate: () => unknown }) => void args.mutate()
  })
}))

vi.mock('@/components/sidebar/CommentMarkdown', () => ({
  default: ({ content }: { content: string }) => <div>{content}</div>
}))
vi.mock('@/i18n/i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof I18n>()),
  translate: (_key: string, fallback: string, values?: Parameters<typeof I18n.translate>[2]) =>
    fallback.replace(/{{(\w+)}}/g, (match, key: string) => String(values?.[key] ?? match))
}))
vi.mock('@/i18n/relative-time-format', () => ({
  formatUiRelativeTimeFromDate: () => 'now'
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const linkedIssue = {
  provider: 'linear' as const,
  identifier: 'LIN-1',
  workspaceId: 'workspace-1',
  organizationUrlKey: 'acme',
  url: 'https://linear.invalid/LIN-1',
  title: 'Fix checkout'
}

/** The workspace's own host: what the pane routes by when it has no creation-time task source. */
const OWNER_SOURCE: TaskSourceContext = {
  kind: 'task-source',
  provider: 'linear',
  projectId: 'account-backed-task-source',
  hostId: 'runtime:pane-owner'
}

/** A creation-time task source on another server: the linked issue's own provider account. */
const LINKED_TASK_SOURCE: TaskSourceContext = {
  kind: 'task-source',
  provider: 'linear',
  projectId: 'project-1',
  hostId: 'runtime:task-owner'
}

function issue(): LinearIssue {
  return {
    id: 'lin-1',
    identifier: 'LIN-1',
    title: 'Fix checkout',
    description: 'Body',
    url: 'https://linear.invalid/LIN-1',
    workspaceId: 'workspace-1',
    team: { id: 'team-1', name: 'Platform', key: 'PLT' },
    state: { name: 'Open', type: 'unstarted', color: '#888' },
    priority: 2,
    estimate: null,
    labels: [],
    labelIds: [],
    updatedAt: '2026-09-02T00:00:00.000Z'
  }
}

function renderPane(source: TaskSourceContext): void {
  render(
    <TooltipProvider delayDuration={0}>
      <LinearLinkedIssuePane linkedIssue={linkedIssue} sourceContext={source} />
    </TooltipProvider>
  )
}

beforeEach(() => {
  // The pane's markdown editor subscribes to the context-menu channel on mount.
  Object.assign(window, { api: { ui: { onRichMarkdownContextCommand: vi.fn(() => vi.fn()) } } })
  mocks.linearGetIssue.mockResolvedValue(issue())
  mocks.linearIssueComments.mockResolvedValue([])
  mocks.linearUpdateIssue.mockResolvedValue({ ok: true })
  mocks.linearAddIssueComment.mockResolvedValue({ ok: true, id: 'comment-1' })
  mocks.readTeamStates.mockReturnValue({
    data: [
      { id: 'state-1', name: 'Open', type: 'unstarted', color: '#888' },
      { id: 'state-2', name: 'Done', type: 'completed', color: '#0a0' }
    ],
    loading: false,
    error: null
  })
  // Both pane sources' entries, so every case starts from the cache state the pane's own
  // `fetchLinearIssue` would leave behind.
  for (const source of [OWNER_SOURCE, LINKED_TASK_SOURCE]) {
    mocks.linearIssueCache[
      scopedLinearCacheKeyForSource(source, `all::${linkedIssue.identifier}`)
    ] = { data: issue(), fetchedAt: Date.now() }
  }
})
afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'api')
  vi.clearAllMocks()
  for (const key of Object.keys(mocks.linearIssueCache)) {
    delete mocks.linearIssueCache[key]
  }
})

describe('LinearLinkedIssuePane owner routing', () => {
  it('fetches, hydrates and comments through the workspace owner, never the Active Server', async () => {
    renderPane(OWNER_SOURCE)
    await screen.findByLabelText('Issue title')

    // The store hydration is the path that used to fall back to the Active Server: it must carry
    // the same source the detail hook reads with, or the pane loads one host and saves to another.
    expect(mocks.fetchLinearIssue).toHaveBeenCalledWith(linkedIssue.identifier, 'all', {
      sourceContext: OWNER_SOURCE
    })
    expect(mocks.linearGetIssue).toHaveBeenCalledWith(OWNER_SOURCE, 'lin-1', 'workspace-1')
    expect(mocks.linearIssueComments).toHaveBeenCalledWith(OWNER_SOURCE, 'lin-1', 'workspace-1')

    fireEvent.change(screen.getByPlaceholderText('Add a comment…'), {
      target: { value: 'Looks good to me' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send comment' }))
    await waitFor(() =>
      expect(mocks.linearAddIssueComment).toHaveBeenCalledWith(
        OWNER_SOURCE,
        'lin-1',
        'Looks good to me',
        'workspace-1'
      )
    )
  })

  it('saves a property edit through the same owner as the read', async () => {
    renderPane(OWNER_SOURCE)
    const statusRow = await screen.findByRole('button', { name: /Open/ })
    fireEvent.click(statusRow)
    fireEvent.click(await screen.findByRole('button', { name: 'Done' }))

    await waitFor(() =>
      expect(mocks.linearUpdateIssue).toHaveBeenCalledWith(
        OWNER_SOURCE,
        'lin-1',
        { stateId: 'state-2' },
        'workspace-1'
      )
    )
  })

  it("ignores an entry another host's account read under the bare identifier key", async () => {
    delete mocks.linearIssueCache[
      scopedLinearCacheKeyForSource(OWNER_SOURCE, `all::${linkedIssue.identifier}`)
    ]
    // What a reader with no source writes through the Active Server.
    mocks.linearIssueCache[`all::${linkedIssue.identifier}`] = {
      data: { ...issue(), title: "Another host's issue" },
      fetchedAt: Date.now()
    }

    renderPane(OWNER_SOURCE)

    // Why: a Linear identifier is unique only inside its workspace, so serving that entry would
    // show one account's issue under another account's owner while the writes here go to the owner.
    // The pane waits for its own owner's read instead, and never paints the other account's issue.
    await waitFor(() =>
      expect(mocks.fetchLinearIssue).toHaveBeenCalledWith(linkedIssue.identifier, 'all', {
        sourceContext: OWNER_SOURCE
      })
    )
    expect(screen.queryByLabelText('Issue title')).toBeNull()
    expect(screen.queryByDisplayValue("Another host's issue")).toBeNull()
  })

  it('routes through whatever source it is handed, without resolving one', async () => {
    renderPane(LINKED_TASK_SOURCE)
    await screen.findByLabelText('Issue title')

    expect(mocks.fetchLinearIssue).toHaveBeenCalledWith(linkedIssue.identifier, 'all', {
      sourceContext: LINKED_TASK_SOURCE
    })
    expect(mocks.linearGetIssue).toHaveBeenCalledWith(LINKED_TASK_SOURCE, 'lin-1', 'workspace-1')
  })
})
