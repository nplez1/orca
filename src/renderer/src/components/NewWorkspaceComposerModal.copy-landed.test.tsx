// @vitest-environment happy-dom
import { useRef } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { NewWorkspaceComposerCardProps } from './new-workspace/new-workspace-composer-card-props'
import type { ReadyProjectHostSetupOption } from '@/lib/project-host-setup-options'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../shared/constants'
import { RUNTIME_CAPABILITIES } from '../../../shared/protocol-version'
import { setLocalRuntimeCapabilitiesForTests } from '../runtime/hosts/capabilities/local-runtime-capabilities'
import type { HostStructuredAgentAvailability } from '../runtime/native-chat/agent-catalogs/host-structured-agent-availability'
import type { Worktree } from '../../../shared/worktree/types'
import { TooltipProvider } from '@/components/ui/tooltip'
import NewWorkspaceComposerModal from './NewWorkspaceComposerModal'

const SETUP_KEY = JSON.stringify(['setup-b', 'runtime:env-b'])
const CLONE_PATH = '/Users/alice/code/orca'

const mocks = vi.hoisted(() => ({
  submit: vi.fn(),
  activate: vi.fn(),
  success: vi.fn(),
  availability: vi.fn<() => HostStructuredAgentAvailability>(),
  cloneBlocksCreate: false
}))

vi.mock('@/components/new-workspace/use-run-target-auto-clone', () => ({
  useRunTargetAutoClone: () => ({
    status: { kind: 'idle' },
    overrides: { url: '', destination: '' },
    setOverrides: () => {},
    defaultUrl: '',
    pendingHostId: null,
    blocksCreate: mocks.cloneBlocksCreate,
    start: () => {},
    retry: () => {},
    cloneAs: () => {},
    clear: () => {}
  })
}))

vi.mock('@/runtime/native-chat/agent-catalogs/use-host-structured-agent-availability.ts', () => ({
  useHostStructuredAgentAvailability: mocks.availability
}))
vi.mock('@/components/agent/AgentSettingsDialog', () => ({ default: () => null }))
vi.mock('@/lib/workspace/activation/worktree-activation.ts', () => ({
  activateAndRevealWorktree: mocks.activate
}))
vi.mock('sonner', () => ({ toast: { success: mocks.success, error: vi.fn(), info: vi.fn() } }))
vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: () => ({
    detectedIds: ['claude'],
    isLoading: false,
    detectionFailed: false,
    needsServerUpdate: false
  })
}))

const readySetup: ReadyProjectHostSetupOption = {
  id: 'setup-b',
  kind: 'ready',
  projectId: 'github:acme/app',
  hostId: 'runtime:env-b',
  repoId: 'repo-b',
  label: 'Build box',
  detail: 'orca',
  path: CLONE_PATH
}

function primaryCheckoutOnMain(): Worktree {
  return {
    id: `repo-b::${CLONE_PATH}`,
    repoId: 'repo-b',
    path: CLONE_PATH,
    head: 'abc123',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: true,
    hostId: 'runtime:env-b',
    displayName: 'main',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
}

vi.mock('@/hooks/useComposerState', () => ({
  useComposerState: () => ({
    cardProps: {
      projectOptions: [],
      selectedRepoIsGit: true,
      detectedAgentIds: new Set(['claude']),
      agentRows: {
        target: { workspace: { kind: 'git-worktree', executionHostId: 'runtime:env-b' } },
        detectionTarget: { kind: 'local' }
      },
      projectHostSetupOptions: [readySetup],
      selectedProjectHostSetupId: 'setup-b',
      selectedRepoExecutionHostId: 'runtime:env-b'
    },
    composerRef: useRef(null),
    submitQuick: mocks.submit,
    createDisabled: false
  })
}))

vi.mock('@/components/NewWorkspaceComposerCard', () => ({
  default: (p: NewWorkspaceComposerCardProps) => (
    <div>
      <button onClick={() => p.onProjectHostSetupChange?.(SETUP_KEY, 'cloned')}>Clone</button>
      <button onClick={() => p.onQuickAgentChange?.(null)}>Blank</button>
      <button onClick={p.onCreate} disabled={p.createDisabled}>
        Create
      </button>
    </div>
  )
}))

const initial = useAppStore.getState()

beforeEach(() => {
  mocks.submit.mockReset()
  mocks.activate.mockReset()
  mocks.success.mockReset()
  mocks.availability.mockReturnValue({ state: 'pending' })
  mocks.cloneBlocksCreate = false
  setLocalRuntimeCapabilitiesForTests(RUNTIME_CAPABILITIES)
  useAppStore.setState({
    activeModal: 'new-workspace-composer',
    modalData: {
      lockedWorkspaceBranch: 'main',
      lockedWorkspaceSourceHostId: 'local',
      lockedWorkspaceIsPrimary: true
    },
    settings: { ...getDefaultSettings('/test'), defaultTuiAgent: 'claude' },
    worktreesByRepo: { 'repo-b': [primaryCheckoutOnMain()] }
  })
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
})

async function create(): Promise<void> {
  fireEvent.click(screen.getByText('Blank'))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Create' })))
}

it('reports the clone as the copy instead of creating a second workspace', async () => {
  render(<NewWorkspaceComposerModal />, { wrapper: TooltipProvider })

  fireEvent.click(screen.getByText('Clone'))
  await create()

  // Why: the clone already holds `main`, so asking the host for it again could only collide.
  expect(mocks.submit).not.toHaveBeenCalled()
  expect(mocks.success).toHaveBeenCalledTimes(1)
  expect(mocks.success.mock.calls[0][0]).toContain('Build box')
  expect(mocks.activate).toHaveBeenCalledWith(`repo-b::${CLONE_PATH}`, {
    navigationIntent: 'user-open'
  })
  expect(useAppStore.getState().activeModal).not.toBe('new-workspace-composer')
})

it('still creates when the checkout we cloned is not on the copied branch', async () => {
  useAppStore.setState({
    worktreesByRepo: {
      'repo-b': [{ ...primaryCheckoutOnMain(), branch: 'refs/heads/develop' }]
    }
  })
  render(<NewWorkspaceComposerModal />, { wrapper: TooltipProvider })

  fireEvent.click(screen.getByText('Clone'))
  await create()

  expect(mocks.success).not.toHaveBeenCalled()
  expect(mocks.submit).toHaveBeenCalledTimes(1)
})

it('says a branch the clone took belongs to the main checkout, not to the copied workspace', async () => {
  // Why: a non-primary workspace on the default branch is the case the shortcut could misreport.
  useAppStore.setState({
    modalData: { lockedWorkspaceBranch: 'main', lockedWorkspaceSourceHostId: 'local' }
  })
  render(<NewWorkspaceComposerModal />, { wrapper: TooltipProvider })

  fireEvent.click(screen.getByText('Clone'))
  await create()

  expect(mocks.submit).not.toHaveBeenCalled()
  expect(mocks.success.mock.calls[0][0]).toContain('one checkout per branch')
  expect(mocks.success.mock.calls[0][0]).not.toContain('This project is now on')
  expect(mocks.activate).toHaveBeenCalledWith(`repo-b::${CLONE_PATH}`, {
    navigationIntent: 'user-open'
  })
})

it('creates the copied workspace when the clone landed on another branch', async () => {
  useAppStore.setState({
    modalData: { lockedWorkspaceBranch: 'feature-x', lockedWorkspaceSourceHostId: 'local' }
  })
  render(<NewWorkspaceComposerModal />, { wrapper: TooltipProvider })

  fireEvent.click(screen.getByText('Clone'))
  await create()

  // Why: the primary checkout stays on the default branch and the copy needs its own worktree.
  expect(mocks.success).not.toHaveBeenCalled()
  expect(mocks.submit).toHaveBeenCalledTimes(1)
  expect(mocks.submit.mock.calls[0][1]).toMatchObject({ exactBranchName: true })
})

it('cannot create while a clone for the chosen host is unfinished', async () => {
  mocks.cloneBlocksCreate = true
  render(<NewWorkspaceComposerModal />, { wrapper: TooltipProvider })

  // Why: the selected setup is still the previous host, so creating would land in the wrong place.
  expect(screen.getByRole('button', { name: 'Create' })).toHaveProperty('disabled', true)
})
