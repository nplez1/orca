import { describe, expect, it } from 'vitest'
import {
  isGitHubPRAdminBypassAvailable,
  type GitHubPRAdminBypassInput
} from './pull-request-admin-bypass'

/** An approval-gated pull request whose merge box GitHub reports as open for this viewer. */
function bypassable(overrides: Partial<GitHubPRAdminBypassInput> = {}): GitHubPRAdminBypassInput {
  return {
    state: 'open',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'UNSTABLE',
    reviewDecision: 'REVIEW_REQUIRED',
    viewerCanMergeAsAdmin: true,
    mergeQueueRequired: false,
    ...overrides
  }
}

describe('isGitHubPRAdminBypassAvailable', () => {
  it('is available when the viewer may waive an unmet review gate that is the only blocker', () => {
    expect(isGitHubPRAdminBypassAvailable(bypassable())).toBe(true)
    for (const mergeStateStatus of ['CLEAN', 'UNSTABLE', 'HAS_HOOKS', 'clean', 'unstable']) {
      expect(isGitHubPRAdminBypassAvailable(bypassable({ mergeStateStatus }))).toBe(true)
    }
    expect(
      isGitHubPRAdminBypassAvailable(bypassable({ reviewDecision: 'CHANGES_REQUESTED' }))
    ).toBe(true)
  })

  it('is never available on an unanswered privilege, whoever asks', () => {
    for (const viewerCanMergeAsAdmin of [undefined, false]) {
      expect(isGitHubPRAdminBypassAvailable(bypassable({ viewerCanMergeAsAdmin }))).toBe(false)
    }
  })

  it('is never available without an unmet review gate to waive', () => {
    for (const reviewDecision of ['APPROVED', null, undefined] as const) {
      expect(isGitHubPRAdminBypassAvailable(bypassable({ reviewDecision }))).toBe(false)
    }
  })

  it('fails closed when the base branch might require a merge queue', () => {
    // Why: the flag that carries a bypass to GitHub also skips the queue, and an unrun or
    // rate-limited merge-metadata probe leaves this unknown rather than false.
    for (const mergeQueueRequired of [true, null, undefined]) {
      expect(isGitHubPRAdminBypassAvailable(bypassable({ mergeQueueRequired }))).toBe(false)
    }
  })

  it('stays closed while GitHub reports the merge box itself blocked', () => {
    // Why: BLOCKED can mean required checks are failing, which the confirmation does not cover.
    for (const mergeStateStatus of ['BLOCKED', 'BEHIND', 'DIRTY', 'DRAFT', '', null, undefined]) {
      expect(isGitHubPRAdminBypassAvailable(bypassable({ mergeStateStatus }))).toBe(false)
    }
    expect(isGitHubPRAdminBypassAvailable(bypassable({ mergeStateStatus: 'UNKNOWN' }))).toBe(false)
  })

  it('is not available where a bypass cannot help', () => {
    for (const state of ['closed', 'merged', 'draft'] as const) {
      expect(isGitHubPRAdminBypassAvailable(bypassable({ state }))).toBe(false)
    }
    expect(isGitHubPRAdminBypassAvailable(bypassable({ mergeable: 'CONFLICTING' }))).toBe(false)
    expect(isGitHubPRAdminBypassAvailable(bypassable({ mergeStateStatus: 'DIRTY' }))).toBe(false)
  })
})
