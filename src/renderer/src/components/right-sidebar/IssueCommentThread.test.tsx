// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IssueCommentThread, type IssueCommentView } from './IssueCommentThread'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback?: string) => fallback ?? _key
}))
vi.mock('@/i18n/relative-time-format', () => ({
  formatUiRelativeTimeFromDate: () => 'now'
}))
vi.mock('@/components/sidebar/CommentMarkdown', () => ({
  default: ({ content }: { content: string }) => <div data-testid="comment-body">{content}</div>
}))

const COMMENT: IssueCommentView = {
  id: 'c1',
  authorName: 'Nathan Parker',
  authorAvatarUrl: 'https://avatars.example/n.png',
  createdAt: '2026-10-01T00:00:00.000Z',
  body: 'Looks good to me.'
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('IssueCommentThread', () => {
  it('renders each comment with its author and body', () => {
    render(
      <IssueCommentThread comments={[COMMENT]} loading={false} error={null} onRetry={() => {}} />
    )
    expect(screen.getByText('Comments')).toBeTruthy()
    expect(screen.getByText('Nathan Parker')).toBeTruthy()
    expect(screen.getByTestId('comment-body').textContent).toBe('Looks good to me.')
  })

  it('shows the empty state when there are no comments', () => {
    render(<IssueCommentThread comments={[]} loading={false} error={null} onRetry={() => {}} />)
    expect(screen.getByText('No comments yet.')).toBeTruthy()
  })

  it('shows the error with a retry that fires', () => {
    const onRetry = vi.fn()
    render(
      <IssueCommentThread
        comments={[]}
        loading={false}
        error="Failed to load comments."
        onRetry={onRetry}
      />
    )
    expect(screen.getByText('Failed to load comments.')).toBeTruthy()
    fireEvent.click(screen.getByText('Retry'))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
})
