import { describe, expect, it } from 'vitest'
import { PullRequest } from './github-pull-request-params'

/**
 * `github.prComments` is the only call that opts into review-verdict entries, and the flag has to
 * survive the schema for the Checks panel to work on a remote or web-backed host. A field that the
 * schema silently drops fails open — the panel just shows no verdicts, with nothing in a log.
 */
describe('github.prComments verdict opt-in wire compatibility', () => {
  it('keeps the opt-in when a caller sends it', () => {
    expect(
      PullRequest.parse({ repo: 'repo-1', prNumber: 42, includeReviewVerdicts: true })
        .includeReviewVerdicts
    ).toBe(true)
  })

  it('leaves it unset for a caller that predates it', () => {
    expect(
      PullRequest.parse({ repo: 'repo-1', prNumber: 42 }).includeReviewVerdicts
    ).toBeUndefined()
    expect(
      PullRequest.parse({ repo: 'repo-1', prNumber: 42, includeReviewVerdicts: false })
        .includeReviewVerdicts
    ).toBe(false)
  })
})
