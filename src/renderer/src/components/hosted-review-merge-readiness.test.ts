import { describe, expect, it } from 'vitest'
import {
  getHostedReviewMergeReadiness,
  hostedReviewMergeVerdictLabel,
  type HostedReviewMergeReadinessInput
} from './hosted-review-merge-readiness'

function github(overrides: Partial<HostedReviewMergeReadinessInput> = {}) {
  return getHostedReviewMergeReadiness({ state: 'open', mergeable: 'MERGEABLE', ...overrides })
}

describe('getHostedReviewMergeReadiness', () => {
  it('reports an approval requirement as waiting rather than mergeable', () => {
    // The reported bug: green checks plus a pending approval used to read as mergeable.
    const readiness = github({
      reviewDecision: 'REVIEW_REQUIRED',
      mergeStateStatus: 'BLOCKED'
    })

    expect(readiness).toMatchObject({
      readiness: 'waiting',
      marker: 'waiting',
      reason: 'Approval required'
    })
  })

  it('separates a human blocker from a policy one', () => {
    expect(github({ reviewDecision: 'CHANGES_REQUESTED' })).toMatchObject({
      readiness: 'blocked',
      marker: 'blocked',
      reason: 'Changes requested'
    })
    expect(github({ mergeable: 'CONFLICTING' })).toMatchObject({
      readiness: 'blocked',
      marker: 'blocked',
      reason: 'Conflicts'
    })
    expect(github({ mergeStateStatus: 'BLOCKED' })).toMatchObject({
      readiness: 'blocked',
      marker: 'blocked',
      reason: 'Blocked'
    })
  })

  it('treats a stale branch and a merge queue as waiting, not blocked', () => {
    expect(github({ mergeStateStatus: 'BEHIND' })).toMatchObject({
      readiness: 'waiting',
      marker: 'waiting',
      reason: 'Behind base'
    })
    // A CLEAN merge box with a required queue still cannot be merged directly.
    expect(github({ mergeStateStatus: 'CLEAN', mergeQueueRequired: true })).toMatchObject({
      readiness: 'waiting',
      marker: 'waiting',
      reason: 'Merge queue'
    })
  })

  it('only calls a review mergeable when the provider says the merge box is open', () => {
    expect(github({ mergeStateStatus: 'CLEAN' })).toMatchObject({
      readiness: 'mergeable',
      marker: 'none',
      reason: 'Ready to merge'
    })
    // UNSTABLE still merges: the failing checks are not required ones.
    expect(github({ mergeStateStatus: 'UNSTABLE' })).toMatchObject({ readiness: 'mergeable' })
    expect(github({ mergeStateStatus: 'HAS_HOOKS' })).toMatchObject({ readiness: 'mergeable' })
  })

  it('never reports a mergeable review without positive provider evidence', () => {
    const inputs: HostedReviewMergeReadinessInput[] = [
      { state: 'open' },
      { state: 'open', mergeable: undefined },
      { state: 'open', mergeable: 'UNKNOWN' },
      { state: 'open', mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' },
      { state: 'open', reviewDecision: 'APPROVED' },
      { state: 'open', mergeStateStatus: 'UNKNOWN' }
    ]

    for (const input of inputs) {
      expect(getHostedReviewMergeReadiness(input).readiness).not.toBe('mergeable')
    }
  })

  it('keeps an open merge box mergeable even when optional checks are red', () => {
    // Why: GitHub's UNSTABLE means *non-required* checks are failing and the merge is still
    // allowed, so reporting "blocked" would be a wrong answer in the module other surfaces
    // trust. CI is the checks channel's story, so the reason stays empty.
    for (const mergeStateStatus of ['CLEAN', 'UNSTABLE', 'HAS_HOOKS']) {
      expect(github({ mergeStateStatus, status: 'failure' })).toMatchObject({
        readiness: 'mergeable',
        marker: 'none',
        reason: ''
      })
      expect(github({ mergeStateStatus, status: 'pending' })).toMatchObject({
        readiness: 'mergeable',
        marker: 'none',
        reason: ''
      })
    }
  })

  it('weighs CI against a bare mergeable, which says only "no conflicts"', () => {
    // A bare `mergeable` (Bitbucket, Azure DevOps, Gitea) accounts for neither required checks
    // nor approvals, so red CI is enough to disqualify it.
    expect(github({ mergeStateStatus: undefined, status: 'failure' })).toMatchObject({
      readiness: 'blocked',
      marker: 'none',
      reason: ''
    })
    expect(github({ mergeStateStatus: undefined, status: 'pending' })).toMatchObject({
      readiness: 'waiting',
      marker: 'none',
      reason: ''
    })
  })

  it('does not raise a marker for a blocker the checks glyph already carries', () => {
    // Why: the glyph's colour is the CI channel. A marker that fires for CI would say no
    // more than the colour it sits on, and would dot nearly every in-flight PR.
    const checksOnly: HostedReviewMergeReadinessInput[] = [
      { state: 'open', mergeStateStatus: 'CLEAN', status: 'failure' },
      { state: 'open', mergeStateStatus: 'CLEAN', status: 'pending' },
      { state: 'open', mergeStateStatus: 'ci_must_pass' },
      { state: 'open', mergeStateStatus: 'ci_still_running' }
    ]

    for (const input of checksOnly) {
      const readiness = getHostedReviewMergeReadiness(input)
      expect(readiness.marker).toBe('none')
      // Null keeps the same fact out of the merge-readiness badge and the card tooltip.
      expect(hostedReviewMergeVerdictLabel(readiness)).toBeNull()
    }
  })

  it('repeats only the verdicts a reader cannot get from the checks badge', () => {
    expect(hostedReviewMergeVerdictLabel(github({ reviewDecision: 'REVIEW_REQUIRED' }))).toBe(
      'Approval required'
    )
    expect(hostedReviewMergeVerdictLabel(github({ mergeStateStatus: 'CLEAN' }))).toBe(
      'Ready to merge'
    )
    // Checks-only, and no verdict reported at all, both stay unsaid.
    expect(hostedReviewMergeVerdictLabel(github({ status: 'failure' }))).toBeNull()
    expect(hostedReviewMergeVerdictLabel(github({ mergeable: 'UNKNOWN' }))).toBeNull()
    // A computing state *does* speak: the reader cannot get "not decided yet" anywhere else.
    expect(hostedReviewMergeVerdictLabel(github({ mergeStateStatus: 'UNKNOWN' }))).toBe('Checking')
    expect(
      hostedReviewMergeVerdictLabel(
        getHostedReviewMergeReadiness({ state: 'merged', mergeable: 'MERGEABLE' })
      )
    ).toBeNull()
  })

  it('marks an uncomputed merge state as undecided rather than as mergeable', () => {
    // Why: GitHub recomputes mergeStateStatus after every push, and during that window even an
    // approval-blocked PR is unknown. A dotless green glyph would read as mergeable, which is
    // the conflation this whole change removes; a muted dot says "not decided" without crying
    // wolf about a blocker that may not exist.
    const readiness = github({ mergeStateStatus: 'UNKNOWN' })

    expect(readiness).toMatchObject({ readiness: 'undetermined', marker: 'checking' })
    expect(hostedReviewMergeVerdictLabel(readiness)).toBe('Checking')
  })

  it('trusts a bare MERGEABLE from providers that report no merge state', () => {
    // Bitbucket, Azure DevOps and Gitea map only `mergeable`, so it is the whole signal.
    expect(github({ mergeable: 'MERGEABLE', mergeStateStatus: undefined })).toMatchObject({
      readiness: 'mergeable'
    })
    expect(
      github({ mergeable: 'UNKNOWN', mergeStateStatus: undefined, status: 'success' })
    ).toMatchObject({ readiness: 'undetermined', marker: 'none', reason: '' })
  })

  it('maps GitLab merge statuses to the same vocabulary', () => {
    expect(github({ mergeStateStatus: 'not_approved' })).toMatchObject({
      readiness: 'waiting',
      reason: 'Approval required'
    })
    expect(github({ mergeStateStatus: 'requested_changes' })).toMatchObject({
      readiness: 'blocked',
      reason: 'Changes requested'
    })
    expect(github({ mergeStateStatus: 'discussions_not_resolved' })).toMatchObject({
      readiness: 'waiting',
      reason: 'Unresolved threads'
    })
    expect(github({ mergeStateStatus: 'need_rebase' })).toMatchObject({
      readiness: 'waiting',
      reason: 'Behind base'
    })
    expect(github({ mergeStateStatus: 'policies_denied' })).toMatchObject({
      readiness: 'blocked',
      reason: 'Blocked'
    })
  })

  it('claims nothing for reviews whose state is not open', () => {
    for (const state of ['merged', 'closed', 'draft'] as const) {
      const readiness = getHostedReviewMergeReadiness({
        state,
        mergeable: 'CONFLICTING',
        reviewDecision: 'CHANGES_REQUESTED'
      })
      expect(readiness).toEqual({ readiness: 'not-applicable', marker: 'none', reason: '' })
    }
  })

  it('claims nothing for a linked-review row whose details have not arrived', () => {
    const readiness = getHostedReviewMergeReadiness({})

    expect(readiness).toMatchObject({ readiness: 'undetermined', marker: 'none', reason: '' })
  })
})
