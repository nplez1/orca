// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JiraCreateField, JiraTransition } from '../../../shared/jira-types'
import { JiraTransitionFieldsForm } from './jira-transition-fields-form'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

afterEach(cleanup)

/** Component/s with the project's own list behind it, as the host now offers it. */
const COMPONENTS_FIELD: JiraCreateField = {
  key: 'components',
  name: 'Component/s',
  required: true,
  schema: { type: 'array', items: 'string', system: 'components' },
  allowedValues: [
    { id: '10400', name: 'Web' },
    { id: '10401', name: 'Platform' }
  ]
}

const TRANSITION: JiraTransition = {
  id: '31',
  name: 'Start work',
  to: { id: '3', name: 'Doing', categoryKey: 'indeterminate', categoryName: 'In progress' }
}

describe('JiraTransitionFieldsForm components', () => {
  it('submits a required Component/s as object references', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn().mockResolvedValue({ ok: true })
    render(
      <JiraTransitionFieldsForm
        transition={{ ...TRANSITION, fields: [COMPONENTS_FIELD] }}
        pending={false}
        onBack={vi.fn()}
        onSubmit={onSubmit}
      />
    )

    // The picker the project list makes possible, named rather than numbered.
    const trigger = screen.getByRole('combobox')
    await user.click(trigger)
    await user.click(await screen.findByRole('option', { name: 'Platform' }))
    await user.click(screen.getByRole('button', { name: 'Change status' }))

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          transitionId: '31',
          // <#162> A bare ['10401'] is what Jira rejects for this field.
          transitionFields: { components: [{ id: '10401' }] }
        })
      )
    )
  })

  it('keeps the field shaped as a reference when a rejection brings it back', async () => {
    // A rejected field comes back holding the issue's own value and is sent as-is; the
    // shape it is sent in is the whole fix, so it must not fall back to strings.
    const user = userEvent.setup()
    const onSubmit = vi.fn().mockResolvedValue({ ok: true })
    render(
      <JiraTransitionFieldsForm
        transition={{
          ...TRANSITION,
          fields: [{ ...COMPONENTS_FIELD, currentValue: '10400', hasCurrentValue: true }]
        }}
        pending={false}
        onBack={vi.fn()}
        onSubmit={onSubmit}
        forcedFieldKeys={new Set(['components'])}
      />
    )

    expect(screen.getByRole('combobox').textContent).toContain('Web')
    await user.click(screen.getByRole('button', { name: 'Change status' }))

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          transitionFields: { components: [{ id: '10400' }] }
        })
      )
    )
  })

  it('asks for a required Component/s the issue does not fill', async () => {
    // The blank-draft gate: nothing is submitted until the field has a value, and the
    // button stays disabled rather than sending the request Jira would refuse.
    render(
      <JiraTransitionFieldsForm
        transition={{ ...TRANSITION, fields: [COMPONENTS_FIELD] }}
        pending={false}
        onBack={vi.fn()}
        onSubmit={vi.fn()}
      />
    )

    expect(screen.getByRole('button', { name: 'Change status' })).toHaveProperty('disabled', true)
  })
})
