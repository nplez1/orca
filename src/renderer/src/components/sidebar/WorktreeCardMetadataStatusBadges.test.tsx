import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import { ReviewMergeReadinessBadge } from './WorktreeCardMetadataStatusBadges'
import type { WorktreeCardPrDisplay } from './worktree-card-pr-display'

const PASSING_CHECKS: HostedReviewInfo = {
  provider: 'github',
  number: 123,
  title: 'Review me',
  state: 'open',
  url: 'https://example.com/pull/123',
  status: 'success',
  updatedAt: '2026-01-01T00:00:00.000Z',
  mergeable: 'MERGEABLE'
}

function reviewWith(overrides: Partial<HostedReviewInfo>): WorktreeCardPrDisplay {
  return { ...PASSING_CHECKS, ...overrides }
}

function render(overrides: Partial<HostedReviewInfo>): string {
  return renderToStaticMarkup(<ReviewMergeReadinessBadge review={reviewWith(overrides)} />)
}

describe('ReviewMergeReadinessBadge', () => {
  it('names the blocker that green checks cannot express', () => {
    const markup = render({ reviewDecision: 'REVIEW_REQUIRED' })

    expect(markup).toContain('Approval required')
    expect(markup).toContain('border-status-warning-border')
    expect(markup).toContain('title="Merge: Approval required"')
  })

  it('separates a blocked verdict from a waiting one by tone, not just by wording', () => {
    const blockedMarkup = render({ mergeable: 'CONFLICTING' })

    expect(blockedMarkup).toContain('Conflicts')
    expect(blockedMarkup).toContain('text-destructive')
    expect(blockedMarkup).not.toContain('border-status-warning-border')
  })

  it('confirms a fully mergeable review instead of staying silent', () => {
    const markup = render({ mergeStateStatus: 'CLEAN' })

    expect(markup).toContain('Ready to merge')
    expect(markup).toContain('border-status-success-border')
  })

  it('stays silent when the checks badge beside it already carries the story', () => {
    // A failing or pending check is not a merge-readiness finding; the sibling badge says it.
    expect(render({ status: 'failure', mergeStateStatus: 'CLEAN' })).toBe('')
    expect(render({ status: 'pending', mergeStateStatus: 'CLEAN' })).toBe('')
  })

  it('says so when the provider is still computing, rather than looking mergeable', () => {
    // Why: after a push every blocker is momentarily unknown, including approvals, so silence
    // here would read as "ready" — the conflation this badge exists to remove.
    const markup = render({ mergeStateStatus: 'UNKNOWN' })

    expect(markup).toContain('Checking')
    expect(markup).toContain('border-status-warning-border')
    expect(markup).not.toContain('Ready to merge')
  })

  it('stays silent when the provider reports no merge state at all', () => {
    // A provider that cannot answer is in that state permanently, so a badge would be noise.
    expect(render({ mergeStateStatus: undefined, mergeable: 'UNKNOWN' })).toBe('')
    // A linked-review row whose details have not arrived yet also has nothing to judge.
    expect(
      renderToStaticMarkup(
        <ReviewMergeReadinessBadge
          review={{ provider: 'github', number: 1, title: 'Loading PR...', status: 'success' }}
        />
      )
    ).toBe('')
  })

  it('stays silent for a review whose state already answers the question', () => {
    for (const state of ['merged', 'closed', 'draft'] as const) {
      expect(render({ state, mergeable: 'CONFLICTING' })).toBe('')
    }
  })
})
