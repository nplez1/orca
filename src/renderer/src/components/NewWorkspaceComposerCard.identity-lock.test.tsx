// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderCard, unmountCard } from './NewWorkspaceComposerCard.test-fixture'

// Why: the card mounts inside the app's TooltipProvider; these cases render it alone.
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

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
