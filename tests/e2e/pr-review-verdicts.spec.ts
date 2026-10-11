import { test, expect } from './helpers/orca-app'
import { openChecks } from './helpers/source-control-ai-generation'
import { seedPRCommentsSidebarFixture } from './helpers/pr-comments-sidebar-fixture'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import type { PRComment } from '../../src/shared/github/comment-types'

/**
 * GitHub's review submissions on one PR: a change request that carried a comment body, and an
 * approval that carried none — the event the old data path dropped entirely.
 */
const REVIEW_VERDICT_COMMENTS: PRComment[] = [
  {
    id: 201,
    author: 'coderabbitai',
    authorAvatarUrl: '',
    body: 'Please split this into two PRs before merge.',
    createdAt: '2026-05-14T12:00:00.000Z',
    url: 'https://github.com/acme/orca/pull/73#pullrequestreview-201',
    reviewState: 'CHANGES_REQUESTED',
    isBot: true
  },
  {
    id: 202,
    author: 'ana',
    authorAvatarUrl: '',
    body: '',
    createdAt: '2026-05-14T13:00:00.000Z',
    url: 'https://github.com/acme/orca/pull/73#pullrequestreview-202',
    reviewState: 'APPROVED'
  },
  {
    id: 203,
    author: 'bob',
    authorAvatarUrl: '',
    body: 'Unrelated conversation comment.',
    createdAt: '2026-05-14T14:00:00.000Z',
    url: 'https://github.com/acme/orca/pull/73#issuecomment-203'
  }
]

const CHANGE_REQUEST_BODY = 'Please split this into two PRs before merge.'

test.describe('PR review verdicts in the Checks panel', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('lists a bodyless approval above the Comments header and orders a change request first', async ({
    orcaPage
  }) => {
    const { worktreeId } = await seedPRCommentsSidebarFixture(orcaPage, {
      comments: REVIEW_VERDICT_COMMENTS,
      title: 'E2E PR review verdicts'
    })
    await openChecks(orcaPage, worktreeId)

    const verdictsLabel = orcaPage.getByText('Review verdicts', { exact: true })
    await expect(verdictsLabel).toBeVisible({ timeout: 10_000 })

    const commentsHeader = orcaPage.getByText('Comments', { exact: true })
    const [verdictsBox, commentsBox] = await Promise.all([
      verdictsLabel.boundingBox(),
      commentsHeader.boundingBox()
    ])
    if (!verdictsBox || !commentsBox) {
      throw new Error('Expected both the verdicts block and the Comments header in the panel')
    }
    expect(verdictsBox.y).toBeLessThan(commentsBox.y)

    // The approval arrived with no comment body, so it has no row in the list below.
    await expect(orcaPage.getByText('ana')).toBeVisible()
    await expect(orcaPage.getByText('Approved', { exact: true })).toBeVisible()
    await expect(orcaPage.getByText('No comments', { exact: true })).toHaveCount(0)

    const [changeRequestBox, approvalBox] = await Promise.all([
      orcaPage.getByText('Changes requested', { exact: true }).boundingBox(),
      orcaPage.getByText('Approved', { exact: true }).boundingBox()
    ])
    if (!changeRequestBox || !approvalBox) {
      throw new Error('Expected both verdicts to render')
    }
    expect(changeRequestBox.y).toBeLessThan(approvalBox.y)

    // A verdict with no comment to land on offers no click at all.
    await expect(orcaPage.getByRole('button', { name: /Approved/ })).toHaveCount(0)
  })

  test('a verdict click lands the highlight on its comment without moving keyboard focus', async ({
    orcaPage
  }) => {
    const { worktreeId } = await seedPRCommentsSidebarFixture(orcaPage, {
      comments: REVIEW_VERDICT_COMMENTS,
      title: 'E2E PR review verdicts'
    })
    await openChecks(orcaPage, worktreeId)

    const verdict = orcaPage.getByRole('button', { name: /Changes requested/ })
    await expect(verdict).toBeVisible({ timeout: 10_000 })

    const anchoredCard = orcaPage.getByTestId('pr-comment-group').filter({
      hasText: CHANGE_REQUEST_BODY
    })
    await expect(anchoredCard).toBeVisible()
    await expect(anchoredCard).not.toHaveClass(/ring-2/)

    await verdict.click()

    await expect(anchoredCard).toHaveClass(/ring-2/)
    await expect(anchoredCard).toBeInViewport()
    // Why: this is a scroll-and-mark jump, not a navigation — the reader keeps their keyboard place.
    expect(
      await orcaPage.evaluate(
        () => document.activeElement?.closest('[data-pr-comment-id]') === null
      )
    ).toBe(true)

    // The mark is short-lived.
    await expect(anchoredCard).not.toHaveClass(/ring-2/, { timeout: 5_000 })
  })

  test('resets the audience filter when it hides the comment a verdict points at', async ({
    orcaPage
  }) => {
    const { worktreeId } = await seedPRCommentsSidebarFixture(orcaPage, {
      comments: REVIEW_VERDICT_COMMENTS,
      title: 'E2E PR review verdicts'
    })
    await openChecks(orcaPage, worktreeId)

    const humansTab = orcaPage.getByRole('button', { name: /Humans/ })
    await expect(humansTab).toBeVisible({ timeout: 10_000 })
    await humansTab.click()

    const anchoredCard = orcaPage.getByTestId('pr-comment-group').filter({
      hasText: CHANGE_REQUEST_BODY
    })
    await expect(anchoredCard).toHaveCount(0)
    await expect(humansTab).toHaveAttribute('aria-pressed', 'true')

    await orcaPage.getByRole('button', { name: /Changes requested/ }).click()

    await expect(orcaPage.getByRole('button', { name: /^All/ })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await expect(anchoredCard).toBeVisible()
    await expect(anchoredCard).toHaveClass(/ring-2/)
  })
})
