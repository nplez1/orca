// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AutomationAuthoringDialog } from './AutomationAuthoringDialog'

afterEach(() => {
  cleanup()
})

function renderDialog(
  overrides: Partial<React.ComponentProps<typeof AutomationAuthoringDialog>> = {}
) {
  const onSubmit = vi.fn()
  const onOpenChange = vi.fn()
  render(
    <AutomationAuthoringDialog
      open
      workspaceLabel="main"
      error={null}
      onOpenChange={onOpenChange}
      onSubmit={onSubmit}
      {...overrides}
    />
  )
  return { onSubmit, onOpenChange }
}

describe('AutomationAuthoringDialog', () => {
  it('will not start a session with an empty description', async () => {
    const { onSubmit } = renderDialog()
    const start = screen.getByRole('button', { name: 'Start authoring' })
    expect(start).toBeDisabled()
    await userEvent.setup().click(start)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('hands the trimmed description to the session launcher', async () => {
    const { onSubmit } = renderDialog()
    const user = userEvent.setup()
    await user.type(
      screen.getByLabelText('What should this automation do?'),
      '  Pull and build every day at 7am  '
    )
    await user.click(screen.getByRole('button', { name: 'Start authoring' }))
    expect(onSubmit).toHaveBeenCalledWith('Pull and build every day at 7am')
  })

  it('starts from the keyboard', async () => {
    const { onSubmit } = renderDialog()
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('What should this automation do?'), 'Nightly audit')
    await user.keyboard('{Meta>}{Enter}{/Meta}')
    expect(onSubmit).toHaveBeenCalledWith('Nightly audit')
  })

  it('names the workspace the session will open in', () => {
    renderDialog({ workspaceLabel: 'nplez1/main' })
    expect(screen.getByText(/nplez1\/main/)).toBeInTheDocument()
  })

  it('shows why a session could not be opened', () => {
    renderDialog({ error: 'That workspace or agent is no longer available.' })
    expect(screen.getByText('That workspace or agent is no longer available.')).toBeInTheDocument()
  })
})
