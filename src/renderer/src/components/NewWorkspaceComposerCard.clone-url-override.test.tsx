// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import NewWorkspaceComposerCard from './NewWorkspaceComposerCard'
import type { NewWorkspaceComposerCardProps } from './new-workspace/new-workspace-composer-card-props'
import type { NeedsSetupProjectHostOption } from '@/lib/project-host-setup-options'
import type { RunTargetAutoClone } from './new-workspace/use-run-target-auto-clone'

// Why: the card mounts inside the app's TooltipProvider; this case renders it alone.
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

// Why: the rows live in a Radix popover, which mounts nothing while closed — inline it so the
// run-target row the user would pick is the thing under test.
vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverAnchor: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverArrow: () => null
}))

// Why a stub: the question is which action the row routes to, not what the dialog looks like.
vi.mock('@/components/new-workspace/SetProjectLocationDialog', () => ({
  SetProjectLocationDialog: ({ option }: { option: { hostId: string } | null }) =>
    option ? <div>{`dialog for ${option.hostId}`}</div> : null
}))

const NO_REMOTE_REASON = 'no remote to clone from'

const hostWithoutProject: NeedsSetupProjectHostOption = {
  kind: 'needs-setup',
  id: 'needs-setup:runtime:env-b',
  projectId: 'github:acme/app',
  hostId: 'runtime:env-b',
  label: 'Build box',
  detail: 'Project location not set',
  isAvailable: true,
  attention: false,
  canSetLocation: true
}

const projectOptions: NewWorkspaceComposerCardProps['projectOptions'] = [
  {
    kind: 'project-group',
    id: 'project-group:platform',
    projectGroupId: 'platform',
    displayName: 'Platform',
    badgeColor: 'var(--muted-foreground)',
    detail: '/workspace/platform',
    parentPath: '/workspace/platform',
    connectionId: null
  }
]

function cloneStub(overrides: Partial<RunTargetAutoClone> = {}): RunTargetAutoClone {
  return {
    status: { kind: 'idle' },
    overrides: { url: '', destination: '' },
    setOverrides: vi.fn(),
    defaultUrl: '',
    pendingHostId: null,
    blocksCreate: false,
    start: vi.fn(),
    retry: vi.fn(),
    cloneAs: vi.fn(),
    clear: vi.fn(),
    ...overrides
  }
}

const cardRoots = new WeakMap<HTMLDivElement, Root>()

async function renderCard(props: Partial<NewWorkspaceComposerCardProps>): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  cardRoots.set(container, root)
  await act(async () => {
    root.render(
      <NewWorkspaceComposerCard
        quickAgent={null}
        onQuickAgentChange={() => {}}
        eligibleRepos={[]}
        repoId="repo-a"
        projectOptions={projectOptions}
        selectedProjectId="project-group:platform"
        selectedRepoIsGit
        onRepoChange={() => {}}
        onProjectChange={() => {}}
        primaryActionLabel="Create workspace"
        name=""
        onNameValueChange={() => {}}
        branchNameOverride={undefined}
        onBranchNameOverrideChange={() => {}}
        onSmartGitHubItemSelect={() => {}}
        onSmartGitLabItemSelect={() => {}}
        onSmartBranchSelect={() => {}}
        onSmartLinearIssueSelect={() => {}}
        onClearSmartNameSelection={() => {}}
        smartNameSelection={null}
        canReuseSelectedBranch={false}
        reuseSelectedBranch={false}
        onReuseSelectedBranchChange={() => {}}
        forkPushWarning={null}
        detectedAgentIds={null}
        onOpenAgentSettings={() => {}}
        advancedOpen={false}
        setupChoiceRevealRequest={0}
        onSetupChoiceRevealed={() => {}}
        onToggleAdvanced={() => {}}
        createDisabled={false}
        projectError={null}
        creating={false}
        onCreate={() => {}}
        note=""
        onNoteChange={() => {}}
        setupConfig={null}
        requiresExplicitSetupChoice={false}
        setupDecision={null}
        onSetupDecisionChange={() => {}}
        setupAgentStartupPolicy="wait-for-setup"
        onSetupAgentStartupPolicyChange={() => {}}
        shouldWaitForSetupCheck={false}
        resolvedSetupDecision={null}
        createError={null}
        selectedRepoConnectionId={null}
        selectedRepoSshStatus={null}
        selectedRepoRequiresConnection={false}
        selectedRepoConnectInProgress={false}
        onConnectSelectedRepo={async () => {}}
        canUseSparseCheckout={false}
        sparsePresets={[]}
        sparseSelectedPresetId={null}
        onSparseSelectPreset={() => {}}
        projectHostSetupOptions={[hostWithoutProject]}
        {...props}
      />
    )
  })
  return container
}

function findHostRow(container: HTMLElement): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>('[role="option"]')].find((candidate) =>
    candidate.textContent?.includes(hostWithoutProject.label)
  )
  if (!row) {
    throw new Error('no run-target row for the host')
  }
  return row
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

afterEach(() => {
  for (const node of document.body.querySelectorAll('div')) {
    const root = node instanceof HTMLDivElement ? cardRoots.get(node) : undefined
    if (root) {
      act(() => root.unmount())
      cardRoots.delete(node)
    }
  }
  document.body.innerHTML = ''
})

describe('NewWorkspaceComposerCard clone URL override', () => {
  it('makes a host row clonable from the Advanced URL when the project has no remote', async () => {
    const clone = cloneStub({
      overrides: { url: 'https://github.com/acme/app.git', destination: '' }
    })
    const container = await renderCard({ runTargetClone: clone })

    // Why: the row used to keep saying there is no remote while the field beside it held one.
    expect(container.textContent).not.toContain(NO_REMOTE_REASON)

    await click(findHostRow(container))

    expect(clone.start).toHaveBeenCalledWith(hostWithoutProject)
  })

  it('keeps the existing-folder row when neither a remote nor an override names a URL', async () => {
    const clone = cloneStub()
    const container = await renderCard({ runTargetClone: clone })

    expect(container.textContent).toContain(NO_REMOTE_REASON)

    await click(findHostRow(container))

    expect(clone.start).not.toHaveBeenCalled()
    expect(container.textContent).toContain('dialog for runtime:env-b')
  })
})
