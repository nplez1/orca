import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import { WorktreeCardMetaBadges } from './WorktreeCardMetaBadges'

const PASSING_CHECKS: HostedReviewInfo = {
  provider: 'github',
  number: 456,
  title: 'Review me',
  state: 'open',
  url: 'https://example.com/pull/456',
  status: 'success',
  updatedAt: '2026-01-01T00:00:00.000Z',
  mergeable: 'MERGEABLE'
}

function render(overrides: Partial<HostedReviewInfo>): string {
  return renderToStaticMarkup(
    <WorktreeCardMetaBadges
      issue={null}
      linearIssue={null}
      jiraIssue={null}
      review={{ ...PASSING_CHECKS, ...overrides }}
      comment={null}
      automationProvenance={null}
      cliProvenance={null}
    />
  )
}

describe('WorktreeCardMetaBadges review glyph', () => {
  // Why: this row is where the review glyph lives unless the experimental status lane is on,
  // so dotting only that lane left the glyph the default card actually shows undotted.
  it('carries the merge marker the status lane shows', () => {
    const markup = render({ reviewDecision: 'REVIEW_REQUIRED' })

    expect(markup).toContain('data-review-merge-marker="waiting"')
    expect(markup).toContain('bg-status-warning')
    expect(markup).toContain('text-emerald-500/80')
  })

  // Why: this badge has no tooltip, so an unspoken verdict would leave the dot colour-only.
  it('names a blocker for assistive technology', () => {
    const markup = render({ mergeable: 'CONFLICTING' })

    expect(markup).toContain('data-review-merge-marker="blocked"')
    expect(markup).toContain('Linked PR #456 · Conflicts')
  })

  it('leaves a mergeable review undotted but still says it can merge', () => {
    const markup = render({ mergeStateStatus: 'CLEAN' })

    expect(markup).not.toContain('data-review-merge-marker')
    expect(markup).toContain('Linked PR #456 · Ready to merge')
  })

  it('keeps the GitLab merge-request glyph and an unreported merge state silent', () => {
    const markup = render({
      provider: 'gitlab',
      number: 12,
      title: 'Review me',
      state: 'open',
      status: 'success',
      mergeable: undefined,
      mergeStateStatus: undefined
    })

    expect(markup).toContain('lucide-git-merge')
    expect(markup).toContain('Linked MR #12')
    expect(markup).not.toContain('data-review-merge-marker')
    // Why: MetaIconBadge sizes glyphs with [&>svg]:size-3.5, which no longer reaches the svg
    // once the marker's wrapper span is the direct child.
    expect(markup).toMatch(/<svg[^>]*class="[^"]*\bsize-3\.5\b/)
  })
})
