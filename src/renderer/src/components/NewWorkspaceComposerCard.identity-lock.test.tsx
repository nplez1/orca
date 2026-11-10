// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import NewWorkspaceComposerCard from './NewWorkspaceComposerCard'
import type { NewWorkspaceComposerCardProps } from './new-workspace/new-workspace-composer-card-props'
import type { NewWorkspaceProjectOption } from '@/lib/new-workspace-project-options'
import type { ProjectHostSetupOption } from '@/lib/project-host-setup-options'

// Why: the card mounts inside the app's TooltipProvider; these cases render it alone.
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

// Why: upstream's shared composer fixture was deleted; this suite keeps its own minimal one.
const projectOptions: NewWorkspaceProjectOption[] = [
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

const hostOptions: ProjectHostSetupOption[] = [
  {
    kind: 'ready',
    id: 'setup-local',
    projectId: 'project-group:platform',
    hostId: 'local',
    repoId: 'repo-a',
    label: 'Local Mac',
    detail: 'Orca',
    path: '/Users/alice/orca'
  },
  {
    kind: 'needs-setup',
    id: 'needs-setup:ssh:devbox',
    projectId: 'project-group:platform',
    hostId: 'ssh:devbox',
    label: 'Devbox',
    detail: 'Project location not set',
    isAvailable: true,
    attention: false,
    canSetLocation: true
  }
]

const cardRoots = new WeakMap<HTMLDivElement, Root>()

async function renderCard(
  overrides: Partial<NewWorkspaceComposerCardProps> = {}
): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  cardRoots.set(container, root)
  act(() => {
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
        onSmartGitHubItemSelect={() => {}}
        onSmartGitLabItemSelect={() => {}}
        onSmartBranchSelect={() => {}}
        onSmartLinearIssueSelect={() => {}}
        smartNameSelection={null}
        onClearSmartNameSelection={() => {}}
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
        parentWorktreeId={null}
        onParentWorktreeIdChange={() => {}}
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
        setupAgentStartupPolicy="start-immediately"
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
        branchNameOverride={undefined}
        onBranchNameOverrideChange={() => {}}
        branchesEnabled={false}
        setupControlsEnabled={false}
        sparseControlsEnabled={false}
        projectHostSetupOptions={hostOptions}
        selectedProjectHostSetupId="setup-local"
        {...overrides}
      />
    )
  })
  // Settle mount-time warm before clicking; Vitest serializes overlapping imports unlike browsers.
  await act(async () => {})
  return container
}

function unmountCard(container: HTMLDivElement): void {
  act(() => cardRoots.get(container)?.unmount())
  cardRoots.delete(container)
  container.remove()
}

let container: HTMLDivElement | null = null

afterEach(() => {
  if (container) {
    unmountCard(container)
  }
  container = null
})

describe('composer opened to copy a workspace to another host', () => {
  it('shows the implied name and project as facts and leaves the host as the decision', async () => {
    container = await renderCard({
      identityLocked: true,
      name: 'fix-login',
      selectedProjectId: 'project-group:platform'
    })

    // The branch name is shown, not offered for editing.
    expect(container.textContent).toContain('fix-login')
    expect(container.querySelector('input[value="fix-login"]')).toBeNull()

    // The project is fixed, so its slot offers no picker...
    const projectSlot = container.querySelector(
      '[data-contextual-tour-target="workspace-creation-project"]'
    )
    expect(projectSlot?.querySelector('[role="combobox"]')).toBeNull()
    expect(projectSlot?.textContent).toContain('Platform')

    // ...while the run target stays pickable, including a host without a project location yet.
    const runOnLabel = Array.from(container.querySelectorAll('label')).find((label) =>
      label.textContent?.includes('Run on')
    )
    expect(runOnLabel?.parentElement?.querySelector('[role="combobox"]')).not.toBeNull()
  })

  it('keeps the name editable when the workspace identity is not implied', async () => {
    container = await renderCard({ name: 'fix-login' })

    expect(
      container.querySelector(
        '[data-contextual-tour-target="workspace-creation-project"] [role="combobox"]'
      )
    ).not.toBeNull()
  })

  it('refuses to copy onto the host the workspace already lives on', async () => {
    container = await renderCard({
      identityLocked: true,
      name: 'fix-login',
      lockedTargetIsSourceHost: true,
      createDisabled: true,
      showCreateMultiple: true
    })

    expect(container.textContent).toContain('This workspace already lives on that host')
    // A copy pass would clear the name, which a locked identity cannot refill.
    expect(container.textContent).not.toContain('Create more')
  })
})
