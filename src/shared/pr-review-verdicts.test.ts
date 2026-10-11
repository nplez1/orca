import { describe, expect, it } from 'vitest'
import type { PRComment } from './github/comment-types'
import {
  filterPRCommentListEntries,
  getPRReviewVerdicts,
  isPRReviewVerdictOnlyComment
} from './pr-review-verdicts'

function comment(overrides: Partial<PRComment>): PRComment {
  return {
    id: 1,
    author: 'user',
    authorAvatarUrl: '',
    body: '',
    createdAt: '2026-05-01T00:00:00Z',
    url: '',
    ...overrides
  }
}

describe('pr review verdicts', () => {
  it('treats a review with no body as a verdict rather than a comment entry', () => {
    const approval = comment({ id: 4, reviewState: 'APPROVED' })
    const conversation = comment({ id: 5, body: 'looks fine' })

    expect(isPRReviewVerdictOnlyComment(approval)).toBe(true)
    expect(isPRReviewVerdictOnlyComment(conversation)).toBe(false)
    expect(filterPRCommentListEntries([approval, conversation]).map((entry) => entry.id)).toEqual([
      5
    ])
    expect(getPRReviewVerdicts([approval, conversation])).toEqual([
      expect.objectContaining({ id: 4, hasBody: false, state: 'APPROVED' })
    ])
  })

  it('keeps a review that carried a body in the list and marks its verdict as jumpable', () => {
    const review = comment({ id: 6, reviewState: 'CHANGES_REQUESTED', body: 'Please split this.' })

    expect(filterPRCommentListEntries([review])).toEqual([review])
    expect(getPRReviewVerdicts([review])).toEqual([
      expect.objectContaining({ id: 6, hasBody: true, state: 'CHANGES_REQUESTED' })
    ])
  })

  it('orders a change request above an approval regardless of when it was submitted', () => {
    const verdicts = getPRReviewVerdicts([
      comment({ id: 1, author: 'sam', reviewState: 'APPROVED', createdAt: '2026-05-03T00:00:00Z' }),
      comment({
        id: 2,
        author: 'ana',
        reviewState: 'CHANGES_REQUESTED',
        createdAt: '2026-05-01T00:00:00Z'
      }),
      comment({ id: 3, author: 'kim', reviewState: 'COMMENTED', createdAt: '2026-05-04T00:00:00Z' })
    ])

    expect(verdicts.map((verdict) => verdict.state)).toEqual([
      'CHANGES_REQUESTED',
      'APPROVED',
      'COMMENTED'
    ])
  })

  it("shows only a reviewer's latest verdict", () => {
    const verdicts = getPRReviewVerdicts([
      comment({ id: 1, author: 'ana', reviewState: 'APPROVED', createdAt: '2026-05-01T00:00:00Z' }),
      comment({
        id: 2,
        author: 'ana',
        reviewState: 'CHANGES_REQUESTED',
        createdAt: '2026-05-02T00:00:00Z'
      })
    ])

    expect(verdicts).toEqual([expect.objectContaining({ id: 2, state: 'CHANGES_REQUESTED' })])
  })

  it('does not let a later neutral review retract an earlier decision', () => {
    const verdicts = getPRReviewVerdicts([
      comment({ id: 1, author: 'ana', reviewState: 'APPROVED', createdAt: '2026-05-01T00:00:00Z' }),
      comment({ id: 2, author: 'ana', reviewState: 'COMMENTED', createdAt: '2026-05-02T00:00:00Z' })
    ])

    expect(verdicts).toEqual([expect.objectContaining({ id: 1, state: 'APPROVED' })])
  })

  it('falls back to a neutral review for a reviewer who never decided', () => {
    const verdicts = getPRReviewVerdicts([
      comment({
        id: 1,
        author: 'ana',
        reviewState: 'COMMENTED',
        createdAt: '2026-05-01T00:00:00Z'
      }),
      comment({ id: 2, author: 'ana', reviewState: 'PENDING', createdAt: '2026-05-02T00:00:00Z' })
    ])

    expect(verdicts).toEqual([expect.objectContaining({ id: 2, state: 'PENDING' })])
  })

  it('reports a dismissed review without implying approval', () => {
    const verdicts = getPRReviewVerdicts([
      comment({ id: 1, author: 'ana', reviewState: 'APPROVED', createdAt: '2026-05-01T00:00:00Z' }),
      comment({ id: 2, author: 'ana', reviewState: 'DISMISSED', createdAt: '2026-05-02T00:00:00Z' })
    ])

    expect(verdicts).toEqual([expect.objectContaining({ id: 2, state: 'DISMISSED' })])
  })

  it('flags a bot verdict through the same author rules the comment list uses', () => {
    const [actionsBot] = getPRReviewVerdicts([
      comment({ id: 1, author: 'github-actions[bot]', reviewState: 'APPROVED' })
    ])
    const [connector] = getPRReviewVerdicts([
      comment({ id: 1, author: 'codex-connector', reviewState: 'APPROVED' })
    ])
    const [overridden] = getPRReviewVerdicts(
      [comment({ id: 1, author: 'dependabot', reviewState: 'APPROVED' })],
      new Set(['dependabot'])
    )
    const [human] = getPRReviewVerdicts([
      comment({ id: 1, author: 'ana', reviewState: 'APPROVED' })
    ])

    expect(actionsBot?.isBot).toBe(true)
    expect(connector?.isBot).toBe(true)
    expect(overridden?.isBot).toBe(true)
    expect(human?.isBot).toBe(false)
  })

  it('ignores conversation comments, inline comments, and unknown host states', () => {
    expect(
      getPRReviewVerdicts([
        comment({ id: 1, body: 'a conversation comment' }),
        comment({ id: 2, body: 'an inline comment', threadId: 'T_1', path: 'a.ts', line: 3 }),
        comment({ id: 3, body: 'unmapped', reviewState: undefined })
      ])
    ).toEqual([])
  })

  it('trims the reviewer login and drops a review that has none', () => {
    const verdicts = getPRReviewVerdicts([
      comment({ id: 1, author: '  ana  ', reviewState: 'APPROVED' }),
      comment({ id: 2, author: '', reviewState: 'APPROVED' })
    ])

    expect(verdicts).toEqual([expect.objectContaining({ id: 1, login: 'ana' })])
  })
})
