// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { IssuePaneIssueSwitcher, type IssuePaneIssueSwitcherProps } from './IssuePaneIssueSwitcher'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback?: string, options?: Record<string, unknown>) => {
    let value = fallback ?? _key
    for (const [name, replacement] of Object.entries(options ?? {})) {
      value = value.replace(`{{${name}}}`, String(replacement))
    }
    return value
  }
}))

const twoIssues: IssuePaneIssueSwitcherProps = {
  options: [
    { key: 'github:#12', provider: 'github', identifier: '#12', title: 'Crash on launch' },
    { key: 'jira:PROJ-7', provider: 'jira', identifier: 'PROJ-7', title: 'Checkout is slow' }
  ],
  selectedKey: 'github:#12',
  onSelectIssue: () => {}
}

afterEach(cleanup)

function renderSwitcher(
  switcher: IssuePaneIssueSwitcherProps,
  overrides: Partial<{ openUrl: string | null; onOpenIssue: () => void }> = {}
): void {
  render(
    <TooltipProvider delayDuration={0}>
      <IssuePaneIssueSwitcher
        provider="github"
        identifier="#12"
        openUrl={overrides.openUrl ?? 'https://github.invalid/acme/orca/issues/12'}
        onOpenIssue={overrides.onOpenIssue}
        switcher={switcher}
      />
    </TooltipProvider>
  )
}

describe('IssuePaneIssueSwitcher', () => {
  it('keeps the identifier opening the issue', () => {
    const onOpenIssue = vi.fn()
    renderSwitcher(twoIssues, { onOpenIssue })

    screen.getByRole('button', { name: '#12' }).click()

    expect(onOpenIssue).toHaveBeenCalledWith(
      'https://github.invalid/acme/orca/issues/12',
      expect.anything()
    )
  })

  it('lists every attached issue with the one the pane shows checked', async () => {
    const user = userEvent.setup()
    renderSwitcher(twoIssues)

    await user.click(screen.getByLabelText('Switch issue'))

    const current = screen.getByRole('menuitemradio', { name: /#12/ })
    expect(current.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('menuitemradio', { name: /PROJ-7/ }).getAttribute('aria-checked')).toBe(
      'false'
    )
    expect(screen.getByText('Checkout is slow')).toBeTruthy()
  })

  it('selects the issue the user picks', async () => {
    const user = userEvent.setup()
    const onSelectIssue = vi.fn()
    renderSwitcher({ ...twoIssues, onSelectIssue })

    await user.click(screen.getByLabelText('Switch issue'))
    await user.click(screen.getByRole('menuitemradio', { name: /PROJ-7/ }))

    expect(onSelectIssue).toHaveBeenCalledTimes(1)
    expect(onSelectIssue).toHaveBeenCalledWith('jira:PROJ-7')
  })

  it('still lists the other issues when this one has no link to open', async () => {
    const user = userEvent.setup()
    renderSwitcher(twoIssues, { openUrl: null })

    expect(screen.queryByRole('button', { name: '#12' })).toBeNull()
    await user.click(screen.getByLabelText('Switch issue'))

    expect(screen.getByRole('menuitemradio', { name: /PROJ-7/ })).toBeTruthy()
  })
})
