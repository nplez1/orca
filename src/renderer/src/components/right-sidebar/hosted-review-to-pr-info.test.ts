import { describe, expect, it } from 'vitest'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import { gitHubPRInfoFromHostedReview } from './hosted-review-to-pr-info'

function makeReview(overrides: Partial<HostedReviewInfo> = {}): HostedReviewInfo {
  return {
    provider: 'github',
    number: 12,
    title: 'Add the thing',
    state: 'open',
    url: 'https://github.com/acme/orca/pull/12',
    status: 'pending',
    updatedAt: '2026-05-17T00:00:00.000Z',
    mergeable: 'CONFLICTING',
    ...overrides
  }
}

describe('gitHubPRInfoFromHostedReview', () => {
  it('renames every field the checks pane reads and invents nothing', () => {
    const pr = gitHubPRInfoFromHostedReview(
      makeReview({
        headSha: 'head-oid',
        githubRepository: { owner: 'acme', repo: 'orca' },
        baseRefName: 'main',
        reviewDecision: 'APPROVED',
        mergeStateStatus: 'BEHIND'
      })
    )

    expect(pr).toEqual({
      number: 12,
      title: 'Add the thing',
      state: 'open',
      url: 'https://github.com/acme/orca/pull/12',
      checksStatus: 'pending',
      updatedAt: '2026-05-17T00:00:00.000Z',
      mergeable: 'CONFLICTING',
      reviewDecision: 'APPROVED',
      mergeStateStatus: 'BEHIND',
      headSha: 'head-oid',
      prRepo: { owner: 'acme', repo: 'orca' },
      baseRefName: 'main'
    })
  })

  it('leaves a field absent when the review has no answer for it', () => {
    const pr = gitHubPRInfoFromHostedReview(makeReview())

    expect(pr).not.toBeNull()
    expect(Object.hasOwn(pr ?? {}, 'headSha')).toBe(false)
    expect(Object.hasOwn(pr ?? {}, 'prRepo')).toBe(false)
  })

  it('refuses a review from a provider this pane cannot render as a GitHub PR', () => {
    expect(gitHubPRInfoFromHostedReview(makeReview({ provider: 'gitlab' }))).toBeNull()
    expect(gitHubPRInfoFromHostedReview(null)).toBeNull()
  })
})
