// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { HostedReviewInfo } from '../../../../../shared/hosted-review'
import { ChecksPanelReviewHeader } from './review-header'

afterEach(cleanup)

const review: HostedReviewInfo = {
  provider: 'github',
  number: 42,
  title: 'Keep every link in the app',
  state: 'open',
  url: 'https://github.com/orca/app/pull/42',
  status: 'success',
  updatedAt: '2026-10-29T00:00:00Z',
  mergeable: 'MERGEABLE'
}

function renderHeader(): void {
  render(
    <TooltipProvider>
      <ChecksPanelReviewHeader
        review={review}
        isRefreshing={false}
        canUnlinkReview
        modifierHintDestination={null}
        onRefresh={() => {}}
        onOpenReview={() => {}}
        onUnlinkReview={() => {}}
        onLinkAnotherReview={() => {}}
      />
    </TooltipProvider>
  )
}

describe('ChecksPanelReviewHeader', () => {
  // The review id is a button-styled link, so the app's link menu only finds it through the attribute.
  it('declares the review address on its identifier', () => {
    renderHeader()

    expect(screen.getByRole('button', { name: '#42' }).getAttribute('data-link-url')).toBe(
      review.url
    )
  })
})
