// @vitest-environment happy-dom
import { useRef } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { NewWorkspaceComposerCardProps } from './new-workspace/new-workspace-composer-card-props'
import type { ReadyProjectHostSetupOption } from '@/lib/project-host-setup-options'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../shared/constants'
import { RUNTIME_CAPABILITIES } from '../../../shared/protocol-version'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import type { HostStructuredAgentAvailability } from '@/runtime/host-structured-agent-availability'
import type { Worktree } from '../../../shared/worktree/types'
import { TooltipProvider } from '@/components/ui/tooltip'
import NewWorkspaceComposerModal from './NewWorkspaceComposerModal'

const SETUP_KEY = JSON.stringify(['setup-b', 'runtime:env-b'])
const CLONE_PATH = '/Users/alice/code/orca'

const mocks = vi.hoisted(() => ({
  submit: vi.fn(),
  activate: vi.fn(),
  success: vi.fn(),
  availability: vi.fn<() => HostStructuredAgentAvailability>()
}))

vi.mock('@/runtime/use-host-structured-agent-availability', () => ({
  useHostStructuredAgentAvailability: mocks.availability
}))
vi.mock('@/components/agent/AgentSettingsDialog', () => ({ default: () => null }))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorktree: mocks.activate }))
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
  setLocalRuntimeCapabilitiesForTests(RUNTIME_CAPABILITIES)
  useAppStore.setState({
    activeModal: 'new-workspace-composer',
    modalData: { lockedWorkspaceBranch: 'main', lockedWorkspaceSourceHostId: 'local' },
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
