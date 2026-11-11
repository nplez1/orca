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

// Why a stub: the question is whether the fallback's success releases the pending clone, not what
// the dialog looks like — that has its own suite.
vi.mock('@/components/new-workspace/SetProjectLocationDialog', () => ({
  SetProjectLocationDialog: ({
    option,
    initialPath,
    onReady
  }: {
    option: { hostId: string } | null
    initialPath?: string
    onReady: (setupId: string, provisioning: 'existing-folder') => void
  }) =>
    option ? (
      <div>
        <span>{`dialog for ${option.hostId} at ${initialPath ?? 'no path'}`}</span>
        <button
          type="button"
          onClick={() => onReady('["setup-b","runtime:env-b"]', 'existing-folder')}
        >
          Adopt folder
        </button>
      </div>
    ) : null
}))

const folderOnlyHost: NeedsSetupProjectHostOption = {
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
    status: {
      kind: 'failed',
      target: { hostId: 'runtime:env-b', label: 'Build box', option: folderOnlyHost },
      message: 'Host key verification failed.'
    },
    overrides: { url: '', destination: '' },
    setOverrides: vi.fn(),
    defaultUrl: '',
    pendingHostId: 'runtime:env-b',
    blocksCreate: true,
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
        {...props}
      />
    )
  })
  return container
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label
  )
  if (!button) {
    throw new Error(`no button labelled "${label}"`)
  }
  return button
}

async function click(button: HTMLElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
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

describe('NewWorkspaceComposerCard fallback', () => {
  it('releases the pending clone when the fallback adopts a folder', async () => {
    const clone = cloneStub()
    const onProjectHostSetupChange = vi.fn()
    const container = await renderCard({
      projectHostSetupOptions: [folderOnlyHost],
      runTargetClone: clone,
      onProjectHostSetupChange
    })

    await click(findButton(container, 'Use existing folder'))
    expect(container.textContent).toContain('dialog for runtime:env-b')

    await click(findButton(container, 'Adopt folder'))

    // Why: without this the failure stays on screen and Create stays disabled for good.
    expect(clone.clear).toHaveBeenCalled()
    expect(onProjectHostSetupChange).toHaveBeenCalledWith(
      '["setup-b","runtime:env-b"]',
      'existing-folder'
    )
  })

  it('opens the fallback on the folder a taken clone found', async () => {
    const container = await renderCard({
      projectHostSetupOptions: [folderOnlyHost],
      runTargetClone: cloneStub({
        status: {
          kind: 'folder-taken',
          target: { hostId: 'runtime:env-b', label: 'Build box', option: folderOnlyHost },
          folderName: 'app',
          path: '/srv/checkouts/app',
          suggestion: 'app-2',
          canUseExistingFolder: true
        }
      })
    })

    await click(findButton(container, 'Use existing folder'))

    expect(container.textContent).toContain('at /srv/checkouts/app')
  })
})
