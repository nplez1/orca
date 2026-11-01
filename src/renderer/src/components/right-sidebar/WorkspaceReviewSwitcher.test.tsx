// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { WorkspaceReviewSwitcher } from './WorkspaceReviewSwitcher'
import { makeWorkspaceReviewSelection } from './workspace-review-selection.test-fixture'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback?: string, options?: Record<string, unknown>) => {
    let value = fallback ?? _key
    for (const [name, replacement] of Object.entries(options ?? {})) {
      value = value.replace(`{{${name}}}`, String(replacement))
    }
    return value
  }
}))

afterEach(cleanup)

function renderSwitcher(selection: ReturnType<typeof makeWorkspaceReviewSelection>): void {
  render(
    <TooltipProvider delayDuration={0}>
      <WorkspaceReviewSwitcher selection={selection} />
    </TooltipProvider>
  )
}

const twoReviews = makeWorkspaceReviewSelection({
  hasMultiple: true,
  selected: {
    key: 'github:12',
    provider: 'github',
    number: 12,
    title: 'Add the thing',
    url: 'https://github.invalid/acme/orca/pull/12',
    attachment: null
  },
  entries: [
    {
      key: 'github:12',
      provider: 'github',
      number: 12,
      title: 'Add the thing',
      url: 'https://github.invalid/acme/orca/pull/12',
      attachment: null
    },
    {
      key: 'gitlab:7',
      provider: 'gitlab',
      number: 7,
      title: 'Parent change',
      url: 'https://gitlab.invalid/acme/orca/-/merge_requests/7',
      attachment: null
    }
  ]
})

describe('WorkspaceReviewSwitcher', () => {
  it('stays out of the header when the workspace holds one review', () => {
    renderSwitcher(makeWorkspaceReviewSelection())

    expect(screen.queryByTestId('workspace-review-switcher')).toBeNull()
  })

  it('lists every review with the one the pane shows checked', async () => {
    const user = userEvent.setup()
    renderSwitcher(twoReviews)

    await user.click(screen.getByLabelText('Switch pull request'))

    expect(screen.getByRole('menuitemradio', { name: /PR #12/ }).getAttribute('aria-checked')).toBe(
      'true'
    )
    expect(screen.getByRole('menuitemradio', { name: /MR !7/ }).getAttribute('aria-checked')).toBe(
      'false'
    )
    expect(screen.getByText('Parent change')).toBeTruthy()
  })

  it('reports the review the user picks', async () => {
    const user = userEvent.setup()
    const selectReview = vi.fn()
    renderSwitcher({ ...twoReviews, selectReview })

    await user.click(screen.getByLabelText('Switch pull request'))
    await user.click(screen.getByRole('menuitemradio', { name: /MR !7/ }))

    expect(selectReview).toHaveBeenCalledTimes(1)
    expect(selectReview).toHaveBeenCalledWith('gitlab:7')
  })

  it('names a review the attachment recorded no title for', async () => {
    const user = userEvent.setup()
    renderSwitcher({
      ...twoReviews,
      entries: [{ ...twoReviews.entries[1], title: '' }]
    })

    await user.click(screen.getByLabelText('Switch pull request'))

    expect(screen.getByText('Untitled review')).toBeTruthy()
  })
})
