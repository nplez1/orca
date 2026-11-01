import { describe, expect, it } from 'vitest'
import type { WorkspaceAttachment, Worktree } from '../../../../shared/worktree/types'
import {
  findPickedReviewAttachment,
  findWorkspaceReviewSelection,
  isChecksPaneReviewProvider,
  pickShownReview,
  resolveWorkspaceReviewSelection,
  workspaceReviewSelectionKey
} from './workspace-review-selection'

function makeWorktree(linkedItems: WorkspaceAttachment[]): Pick<Worktree, 'linkedItems'> {
  return { linkedItems }
}

function makeReview(overrides: Partial<WorkspaceAttachment> = {}): WorkspaceAttachment {
  return {
    provider: 'github',
    type: 'pr',
    number: 12,
    title: 'Add the thing',
    url: 'https://github.com/acme/orca/pull/12',
    ...overrides
  }
}

const ACTIVE = {
  provider: 'github' as const,
  number: 12,
  title: 'Add the thing',
  url: 'https://github.com/acme/orca/pull/12'
}

describe('resolveWorkspaceReviewSelection', () => {
  it('leads with the workspace review and keeps every attached review behind it', () => {
    const entries = resolveWorkspaceReviewSelection(
      makeWorktree([
        makeReview({
          number: 9,
          title: 'Parent change',
          url: 'https://github.com/acme/orca/pull/9'
        }),
        makeReview()
      ]),
      ACTIVE
    )

    expect(entries.map((entry) => entry.key)).toEqual(['github:12', 'github:9'])
    expect(entries[0].title).toBe('Add the thing')
  })

  it('lists a review the workspace slot names even before its attachment is written', () => {
    const entries = resolveWorkspaceReviewSelection(makeWorktree([]), ACTIVE)

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ key: 'github:12', attachment: null })
  })

  it('does not list the same review twice when the slot and the attachment agree', () => {
    const entries = resolveWorkspaceReviewSelection(makeWorktree([makeReview()]), ACTIVE)

    expect(entries).toHaveLength(1)
    expect(entries[0].attachment).not.toBeNull()
  })

  it('keeps issues out of the review list', () => {
    const entries = resolveWorkspaceReviewSelection(
      makeWorktree([makeReview({ type: 'issue', number: 5, title: 'Crash on launch' })]),
      ACTIVE
    )

    expect(entries.map((entry) => entry.key)).toEqual(['github:12'])
  })

  it('holds no list for a workspace with neither a review nor attachments', () => {
    expect(resolveWorkspaceReviewSelection(makeWorktree([]), null)).toEqual([])
    expect(resolveWorkspaceReviewSelection(null, null)).toEqual([])
  })

  it('falls back to the workspace review when a stored pick names a review that is gone', () => {
    const entries = resolveWorkspaceReviewSelection(makeWorktree([makeReview()]), ACTIVE)

    expect(findWorkspaceReviewSelection(entries, 'github:404')?.key).toBe('github:12')
    expect(findWorkspaceReviewSelection(entries, null)?.key).toBe('github:12')
    expect(findWorkspaceReviewSelection([], 'github:12')).toBeNull()
  })

  it('names a review by provider and number, not by the attachment key that moves', () => {
    expect(workspaceReviewSelectionKey('github', 12)).toBe('github:12')
    expect(workspaceReviewSelectionKey('gitlab', 7)).toBe('gitlab:7')
  })
})

describe('isChecksPaneReviewProvider', () => {
  it('accepts only the providers the checks pane can render', () => {
    expect(isChecksPaneReviewProvider('github')).toBe(true)
    expect(isChecksPaneReviewProvider('gitlab')).toBe(true)
    expect(isChecksPaneReviewProvider('bitbucket')).toBe(false)
    expect(isChecksPaneReviewProvider('unsupported')).toBe(false)
    expect(isChecksPaneReviewProvider(null)).toBe(false)
  })
})

describe('pickShownReview', () => {
  const review = (provider: 'github' | 'gitlab' | 'bitbucket') => ({
    provider,
    number: 9,
    title: 'Parent change',
    state: 'open' as const,
    url: `https://example.invalid/${provider}/9`,
    status: 'success' as const,
    updatedAt: '2026-05-17T00:00:00.000Z',
    mergeable: 'MERGEABLE' as const
  })

  it('keeps the workspace review while the workspace review is the pick', () => {
    expect(
      pickShownReview({ isWorkspaceReview: true, selectedReview: review('github') }, () => true)
    ).toBeNull()
  })

  it('shows the pick once it has been read and the pane can render it', () => {
    expect(
      pickShownReview(
        { isWorkspaceReview: false, selectedReview: review('gitlab') },
        isChecksPaneReviewProvider
      )?.provider
    ).toBe('gitlab')
  })

  it('keeps the workspace review for a provider the pane cannot render', () => {
    expect(
      pickShownReview(
        { isWorkspaceReview: false, selectedReview: review('bitbucket') },
        isChecksPaneReviewProvider
      )
    ).toBeNull()
  })

  it('keeps the workspace review while the pick is still loading', () => {
    expect(
      pickShownReview({ isWorkspaceReview: false, selectedReview: null }, () => true)
    ).toBeNull()
  })
})

describe('findPickedReviewAttachment', () => {
  const picked = makeReview({
    number: 9,
    title: 'Parent change',
    url: 'https://github.com/acme/orca/pull/9'
  })
  const worktree = makeWorktree([makeReview(), picked])
  const pickedReview = { provider: 'github' as const, number: 9, title: 'Parent change', url: '' }

  it('names the attachment of the review the switcher picked', () => {
    expect(findPickedReviewAttachment(worktree, pickedReview, 'github:9')).toEqual(picked)
  })

  it('answers null when nothing is stored for the workspace', () => {
    expect(findPickedReviewAttachment(worktree, ACTIVE, null)).toBeNull()
    expect(findPickedReviewAttachment(worktree, ACTIVE, undefined)).toBeNull()
  })

  it('answers null for a stored key that no longer names a review the workspace holds', () => {
    expect(findPickedReviewAttachment(worktree, pickedReview, 'github:404')).toBeNull()
    expect(findPickedReviewAttachment(worktree, pickedReview, null)).toBeNull()
  })

  it('names the attachment once the workspace review became the stored key, which the pane clears', () => {
    // Why this shape is reachable at all: the stored key can name what has since become the
    // workspace's own review, and the pane's selection hook clears it on the next commit. Reading
    // the key before that clear still names the review the user is looking at, which is the answer
    // an unlink wants.
    expect(findPickedReviewAttachment(worktree, ACTIVE, 'github:12')).toEqual(
      worktree.linkedItems?.[0]
    )
  })

  it('answers null for a review the workspace holds no attachment for', () => {
    expect(
      findPickedReviewAttachment(
        makeWorktree([]),
        { provider: 'github', number: 9, title: 'Parent change', url: '' },
        'github:9'
      )
    ).toBeNull()
  })
})
