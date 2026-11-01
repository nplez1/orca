// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  WorkspaceReviewSwitcher,
  type WorkspaceReviewSwitcherProps
} from './WorkspaceReviewSwitcher'
import { makeWorkspaceReviewSelectionEntry } from './workspace-review-selection.test-fixture'

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

function renderSwitcher(props: WorkspaceReviewSwitcherProps): void {
  render(
    <TooltipProvider delayDuration={0}>
      <WorkspaceReviewSwitcher {...props} />
    </TooltipProvider>
  )
}

const twoReviews: WorkspaceReviewSwitcherProps = {
  entries: [
    makeWorkspaceReviewSelectionEntry({ key: 'github:12', number: 12, title: 'Add the thing' }),
    makeWorkspaceReviewSelectionEntry({
      key: 'gitlab:7',
      provider: 'gitlab',
      number: 7,
      title: 'Parent change',
      url: 'https://gitlab.invalid/acme/orca/-/merge_requests/7'
    })
  ],
  selectedKey: 'github:12',
  onSelectReview: () => {}
}

describe('WorkspaceReviewSwitcher', () => {
  it('stays out of the header when the pane lists one review', () => {
    renderSwitcher({ ...twoReviews, entries: twoReviews.entries.slice(0, 1) })

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
    const onSelectReview = vi.fn()
    renderSwitcher({ ...twoReviews, onSelectReview })

    await user.click(screen.getByLabelText('Switch pull request'))
    await user.click(screen.getByRole('menuitemradio', { name: /MR !7/ }))

    expect(onSelectReview).toHaveBeenCalledTimes(1)
    expect(onSelectReview).toHaveBeenCalledWith('gitlab:7')
  })

  it('names a review the attachment recorded no title for', async () => {
    const user = userEvent.setup()
    renderSwitcher({
      ...twoReviews,
      entries: [{ ...twoReviews.entries[0], title: '' }, twoReviews.entries[1]]
    })

    await user.click(screen.getByLabelText('Switch pull request'))

    expect(screen.getByText('Untitled review')).toBeTruthy()
  })
})
