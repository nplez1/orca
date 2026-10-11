// @vitest-environment happy-dom

globalThis.IS_REACT_ACT_ENVIRONMENT = true

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { PRComment } from '../../../../../shared/github/comment-types'
import { getPRCommentPresentationClasses } from '../pr-comment-presentation'

vi.mock('@/lib/element-scroll-reveal', () => ({
  scrollElementBottomIntoView: vi.fn(),
  scrollElementCenterIntoView: vi.fn()
}))

vi.mock('@/components/ui/dropdown-menu', () => {
  // Radix keeps the selection callback on the group, so the mocked items need it too.
  let onRadioValueChange: ((value: string) => void) | undefined
  return {
    DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
    DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DropdownMenuItem: ({ children }: { children: ReactNode }) => (
      <button type="button" role="menuitem">
        {children}
      </button>
    ),
    DropdownMenuRadioGroup: ({
      children,
      onValueChange
    }: {
      children: ReactNode
      onValueChange?: (value: string) => void
    }) => {
      onRadioValueChange = onValueChange
      return <>{children}</>
    },
    DropdownMenuRadioItem: ({ children, value }: { children: ReactNode; value?: string }) => (
      <button
        type="button"
        role="menuitemradio"
        onClick={() => {
          if (value !== undefined) {
            onRadioValueChange?.(value)
          }
        }}
      >
        {children}
      </button>
    ),
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
  }
})

import { scrollElementCenterIntoView } from '@/lib/element-scroll-reveal'
import { PRCommentsList } from './comments-list'
import { PR_COMMENT_REVEAL_HIGHLIGHT_MS } from './use-comments-list-state'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  vi.clearAllMocks()
  vi.useRealTimers()
})

function comment(overrides: Partial<PRComment>): PRComment {
  return {
    id: 1,
    author: 'ana',
    authorAvatarUrl: '',
    body: 'A comment',
    createdAt: '2026-05-14T00:00:00Z',
    url: 'https://github.com/acme/widgets/pull/42#issuecomment-1',
    ...overrides
  }
}

function renderList(comments: PRComment[]): void {
  act(() => {
    root.render(
      <TooltipProvider>
        <PRCommentsList
          comments={comments}
          commentsLoading={false}
          selectionContextKey="review:42"
          reviewVerdictsEnabled
        />
      </TooltipProvider>
    )
  })
}

function findButton(text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes(text)
  )
}

function clickText(text: string): void {
  const button = findButton(text)
  if (!button) {
    throw new Error(
      `Button not found: ${text}. Available: ${[...container.querySelectorAll('button')]
        .map((candidate) => candidate.textContent?.trim() ?? '<unlabeled>')
        .join(', ')}`
    )
  }
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function findElementWithExactText(tag: string, text: string): Element | null {
  return (
    [...container.querySelectorAll(tag)].find(
      (candidate) => candidate.textContent?.trim() === text
    ) ?? null
  )
}

function commentRow(commentId: number): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-pr-comment-id="${commentId}"]`)
}

function isHighlighted(commentId: number): boolean {
  const surface =
    commentRow(commentId)?.closest<HTMLElement>('[data-testid="pr-comment-group"]') ?? null
  return surface?.className.includes(getPRCommentPresentationClasses().commentRowHighlight) === true
}

const changeRequestWithBody = comment({
  id: 9,
  author: 'ana',
  reviewState: 'CHANGES_REQUESTED',
  body: 'Please split this into two PRs.'
})

const approvalWithoutBody = comment({
  id: 7,
  author: 'sam',
  reviewState: 'APPROVED',
  body: '',
  authorAvatarUrl: 'https://avatars.example/sam'
})

describe('review verdicts block', () => {
  it('opens the comment section with the verdicts above the Comments header', () => {
    renderList([approvalWithoutBody, changeRequestWithBody])

    const verdictsLabel = findElementWithExactText('div', 'Review verdicts')
    const commentsLabel = findElementWithExactText('span', 'Comments')
    if (!verdictsLabel || !commentsLabel) {
      throw new Error('Expected both the verdicts label and the Comments header to render')
    }
    expect(verdictsLabel.compareDocumentPosition(commentsLabel)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )

    expect(container.textContent).toContain('sam')
    expect(container.textContent).toContain('Changes requested')
    // A change request is the state that must not be missed, so it precedes the approval.
    expect(container.textContent?.indexOf('Changes requested')).toBeLessThan(
      container.textContent?.indexOf('Approved') ?? Number.MAX_SAFE_INTEGER
    )
  })

  it('renders nothing when the PR has no verdicts', () => {
    renderList([comment({ id: 1 })])

    expect(container.textContent).not.toContain('Review verdicts')
  })

  it('shows an approval that arrived without a comment, and does not make it clickable', () => {
    renderList([approvalWithoutBody])

    expect(container.textContent).toContain('Approved')
    // The verdict-only review is not a comment entry, so the list below reports none.
    expect(container.textContent).toContain('No comments')
    expect(findButton('Approved')).toBeUndefined()
  })

  it('does not let a later neutral review overshadow the same reviewer’s decision', () => {
    renderList([
      comment({ id: 11, author: 'kim', reviewState: 'APPROVED', body: '' }),
      comment({ id: 12, author: 'kim', reviewState: 'COMMENTED', body: 'A neutral note' })
    ])

    expect(container.textContent).toContain('Approved')
    expect(container.textContent).not.toContain('Commented')
  })

  it('jumps to the anchored comment, marks it, and clears the mark on a timer', () => {
    vi.useFakeTimers()
    renderList([changeRequestWithBody])

    expect(commentRow(9)).toBeTruthy()
    expect(isHighlighted(9)).toBe(false)

    clickText('Changes requested')

    expect(scrollElementCenterIntoView).toHaveBeenCalledTimes(1)
    expect(vi.mocked(scrollElementCenterIntoView).mock.calls[0]?.[0]).toBe(commentRow(9))
    expect(isHighlighted(9)).toBe(true)

    act(() => {
      vi.advanceTimersByTime(PR_COMMENT_REVEAL_HIGHLIGHT_MS)
    })
    expect(isHighlighted(9)).toBe(false)
  })

  it('resets the audience filter when it hides the comment a verdict points at', () => {
    renderList([
      comment({
        id: 9,
        author: 'greptile-app',
        reviewState: 'CHANGES_REQUESTED',
        body: 'Please split this into two PRs.'
      }),
      comment({ id: 20, author: 'human', body: 'An unrelated human comment' })
    ])

    const humansTab = [...container.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes('Humans')
    )
    if (!humansTab) {
      throw new Error('Expected the audience filter tabs to render')
    }
    act(() => {
      humansTab.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(commentRow(9)).toBeNull()

    clickText('Changes requested')

    const allTab = [...container.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes('All')
    )
    expect(allTab?.getAttribute('aria-pressed')).toBe('true')
    expect(vi.mocked(scrollElementCenterIntoView).mock.calls[0]?.[0]).toBe(commentRow(9))
  })

  it('jumps from timeline mode too, where resolved groups are not collapsed', () => {
    renderList([
      changeRequestWithBody,
      comment({
        id: 30,
        author: 'sam',
        body: 'An inline note on a resolved thread',
        threadId: 'T_30',
        path: 'src/a.ts',
        line: 4,
        isResolved: true
      })
    ])

    clickText('Timeline')
    clickText('Changes requested')

    expect(vi.mocked(scrollElementCenterIntoView).mock.calls[0]?.[0]).toBe(commentRow(9))
  })

  it('opens the collapsed Resolved section when the anchored comment hides inside it', () => {
    // Why this fixture is synthetic: a review submission is a standalone comment, so today nothing
    // puts a verdict's anchor inside the resolved section. The expansion step is here for the day
    // the anchor is a resolved thread comment, and this is the only way to hold it to account.
    renderList([
      comment({
        id: 9,
        author: 'ana',
        reviewState: 'CHANGES_REQUESTED',
        body: 'Please split this into two PRs.',
        threadId: 'T_9',
        path: 'src/a.ts',
        line: 4,
        isResolved: true
      })
    ])

    expect(commentRow(9)).toBeNull()

    clickText('Changes requested')

    expect(commentRow(9)).toBeTruthy()
    expect(vi.mocked(scrollElementCenterIntoView).mock.calls[0]?.[0]).toBe(commentRow(9))
  })
})
