// @vitest-environment happy-dom

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { TaskPageJiraSettingsLink } from './SettingsLink'

const mocks = vi.hoisted(() => ({
  openSettingsPage: vi.fn(),
  openSettingsTarget: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      openSettingsPage: mocks.openSettingsPage,
      openSettingsTarget: mocks.openSettingsTarget
    })
}))

afterEach(() => {
  vi.clearAllMocks()
})

describe('TaskPageJiraSettingsLink', () => {
  it('opens the Jira Tasks settings section directly', async () => {
    const user = userEvent.setup()
    render(
      <TooltipProvider>
        <TaskPageJiraSettingsLink />
      </TooltipProvider>
    )

    await user.click(screen.getByRole('button', { name: 'Jira task settings' }))

    expect(mocks.openSettingsPage).toHaveBeenCalledOnce()
    expect(mocks.openSettingsTarget).toHaveBeenCalledWith({
      pane: 'tasks',
      repoId: null,
      sectionId: 'tasks-jira-board'
    })
  })
})
