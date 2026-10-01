import { describe, expect, it } from 'vitest'
import { presentGitHubPRMergeState, type GitHubPRMergeStateInput } from './github-pr-merge-state'

function pr(overrides: Partial<GitHubPRMergeStateInput> = {}): GitHubPRMergeStateInput {
  return {
    state: 'open',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    checksSummary: { state: 'success', total: 1, passed: 1, failed: 0, pending: 0, neutral: 0 },
    autoMergeAllowed: true,
    ...overrides
  }
}

describe('presentGitHubPRMergeState', () => {
  it('blocks direct merge when approval is required or changes are requested', () => {
    expect(presentGitHubPRMergeState(pr({ reviewDecision: 'REVIEW_REQUIRED' }))).toMatchObject({
      label: 'Approval required',
      directMergeAvailable: false,
      adminBypassRequired: false
    })
    expect(presentGitHubPRMergeState(pr({ reviewDecision: 'CHANGES_REQUESTED' }))).toMatchObject({
      label: 'Changes requested',
      directMergeAvailable: false,
      adminBypassRequired: false
    })
  })

  it('offers the merge, with a required confirmation, when the viewer may waive the review gate', () => {
    const waivable: Partial<GitHubPRMergeStateInput> = {
      viewerCanMergeAsAdmin: true,
      // Why false, not merely not-true: an unknown queue is not permission to skip one.
      mergeQueueRequired: false
    }
    expect(
      presentGitHubPRMergeState(pr({ ...waivable, reviewDecision: 'REVIEW_REQUIRED' }))
    ).toMatchObject({
      // The label stays honest: GitHub does require a review, and still reports it.
      label: 'Approval required',
      directMergeAvailable: true,
      adminBypassRequired: true
    })
    expect(
      presentGitHubPRMergeState(pr({ ...waivable, reviewDecision: 'CHANGES_REQUESTED' }))
        .adminBypassRequired
    ).toBe(true)
  })

  it('does not reach for a bypass where one cannot help', () => {
    const bypassable: Partial<GitHubPRMergeStateInput> = {
      viewerCanMergeAsAdmin: true,
      reviewDecision: 'REVIEW_REQUIRED',
      mergeQueueRequired: false
    }
    // A draft or closed pull request has nothing to merge at all.
    expect(
      presentGitHubPRMergeState(pr({ ...bypassable, state: 'draft' })).adminBypassRequired
    ).toBe(false)
    // Conflicts are not a branch-protection rule.
    expect(
      presentGitHubPRMergeState(pr({ ...bypassable, mergeable: 'CONFLICTING' })).adminBypassRequired
    ).toBe(false)
    // Why: the one flag that carries a bypass to GitHub also skips the merge queue, so neither a
    // base branch that requires the queue nor one whose queue status is unknown is bypass-merged.
    for (const mergeQueueRequired of [true, null, undefined] as const) {
      expect(
        presentGitHubPRMergeState(pr({ ...bypassable, mergeQueueRequired })).adminBypassRequired
      ).toBe(false)
    }
    // Why: BLOCKED can mean required checks are failing, which the bypass confirmation never covers.
    expect(
      presentGitHubPRMergeState(pr({ ...bypassable, mergeStateStatus: 'BLOCKED' }))
        .adminBypassRequired
    ).toBe(false)
    // Nothing to waive once the review gate is satisfied.
    expect(
      presentGitHubPRMergeState(pr({ viewerCanMergeAsAdmin: true, reviewDecision: 'APPROVED' }))
        .adminBypassRequired
    ).toBe(false)
    // Unknown privilege is not permission: an unanswered probe keeps the gate closed.
    expect(
      presentGitHubPRMergeState(pr({ reviewDecision: 'REVIEW_REQUIRED' })).adminBypassRequired
    ).toBe(false)
  })

  it('uses the merge-queue label for auto-merge when a queue is required', () => {
    expect(presentGitHubPRMergeState(pr({ mergeQueueRequired: true }))).toMatchObject({
      label: 'Merge when ready',
      directMergeAvailable: false,
      autoMergeAction: { kind: 'enable', label: 'Merge when ready' }
    })
  })

  it('offers enable auto-merge for open PRs that are waiting on requirements', () => {
    expect(presentGitHubPRMergeState(pr({ mergeQueueRequired: null })).autoMergeAction).toBeNull()
    // Approval-required and required-check-blocked PRs are exactly when auto-merge helps.
    expect(
      presentGitHubPRMergeState(
        pr({ reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED' })
      ).autoMergeAction
    ).toMatchObject({ kind: 'enable', label: 'Enable auto-merge' })
    expect(
      presentGitHubPRMergeState(
        pr({
          mergeStateStatus: 'BLOCKED',
          checksSummary: {
            state: 'pending',
            total: 1,
            passed: 0,
            failed: 0,
            pending: 1,
            neutral: 0
          }
        })
      ).autoMergeAction
    ).toMatchObject({ kind: 'enable', label: 'Enable auto-merge' })
  })

  it('does not offer enable auto-merge when only optional checks are pending', () => {
    expect(
      presentGitHubPRMergeState(
        pr({
          checksSummary: {
            state: 'pending',
            total: 1,
            passed: 0,
            failed: 0,
            pending: 1,
            neutral: 0
          }
        })
      )
    ).toMatchObject({
      label: 'Checks pending',
      directMergeAvailable: true,
      autoMergeAction: null
    })
  })

  it('does not offer enable auto-merge for GitHub unstable PRs', () => {
    expect(
      presentGitHubPRMergeState(
        pr({
          mergeable: 'UNKNOWN',
          mergeStateStatus: 'UNSTABLE',
          checksSummary: {
            state: 'failure',
            total: 1,
            passed: 0,
            failed: 1,
            pending: 0,
            neutral: 0
          }
        })
      ).autoMergeAction
    ).toBeNull()
  })

  it('does not offer enable auto-merge on conflicting PRs (GitHub would reject it)', () => {
    expect(
      presentGitHubPRMergeState(pr({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }))
        .autoMergeAction
    ).toBeNull()
    expect(
      presentGitHubPRMergeState(pr({ mergeable: 'UNKNOWN', mergeStateStatus: 'DIRTY' }))
        .autoMergeAction
    ).toBeNull()
  })

  it('does not offer enable auto-merge when GitHub reports the repository disallows it', () => {
    expect(
      presentGitHubPRMergeState(
        pr({ autoMergeAllowed: false, mergeable: 'UNKNOWN', mergeStateStatus: 'BLOCKED' })
      ).autoMergeAction
    ).toBeNull()
    expect(
      presentGitHubPRMergeState(
        pr({ autoMergeAllowed: undefined, mergeable: 'UNKNOWN', mergeStateStatus: 'BLOCKED' })
      ).autoMergeAction
    ).toMatchObject({ kind: 'enable', label: 'Enable auto-merge' })
  })

  it('offers disable auto-merge when GitHub reports auto-merge is already enabled', () => {
    expect(presentGitHubPRMergeState(pr({ autoMergeEnabled: true }))).toMatchObject({
      autoMergeAction: { kind: 'disable', label: 'Disable auto-merge' }
    })
  })

  it('suppresses enable auto-merge but keeps disable when direct merge is available', () => {
    // Why: enabling auto-merge on a directly-mergeable PR fails with GitHub's
    // "clean status" error, so the dropdown must not offer it.
    expect(
      presentGitHubPRMergeState({
        state: 'open',
        checksSummary: { state: 'success', total: 1, passed: 1, failed: 0, pending: 0, neutral: 0 }
      })
    ).toMatchObject({ label: 'Checks passed', directMergeAvailable: true, autoMergeAction: null })
    expect(presentGitHubPRMergeState(pr())).toMatchObject({
      directMergeAvailable: true,
      autoMergeAction: null
    })
    expect(presentGitHubPRMergeState(pr({ autoMergeEnabled: true })).autoMergeAction).toMatchObject(
      { kind: 'disable' }
    )
  })

  it('blocks conflicts and behind branches, but not optional aggregate check failures', () => {
    expect(
      presentGitHubPRMergeState(pr({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }))
    ).toMatchObject({ label: 'Conflicts', directMergeAvailable: false })
    expect(
      presentGitHubPRMergeState(pr({ mergeable: 'UNKNOWN', mergeStateStatus: 'DIRTY' }))
    ).toMatchObject({ label: 'Conflicts', directMergeAvailable: false })
    expect(presentGitHubPRMergeState(pr({ mergeStateStatus: 'BEHIND' }))).toMatchObject({
      label: 'Behind',
      directMergeAvailable: false
    })
    expect(
      presentGitHubPRMergeState(
        pr({
          checksSummary: {
            state: 'pending',
            total: 1,
            passed: 0,
            failed: 0,
            pending: 1,
            neutral: 0
          }
        })
      )
    ).toMatchObject({ label: 'Checks pending', directMergeAvailable: true })
    expect(
      presentGitHubPRMergeState(
        pr({
          checksSummary: {
            state: 'failure',
            total: 1,
            passed: 0,
            failed: 1,
            pending: 0,
            neutral: 0
          }
        })
      )
    ).toMatchObject({ label: 'Checks failed', directMergeAvailable: true })
    expect(presentGitHubPRMergeState(pr())).toMatchObject({
      label: 'Able to merge',
      directMergeAvailable: true
    })
  })

  it('labels unresolved GitHub mergeability as checking', () => {
    expect(
      presentGitHubPRMergeState(
        pr({
          mergeable: 'UNKNOWN',
          mergeStateStatus: null,
          checksSummary: {
            state: 'pending',
            total: 1,
            passed: 0,
            failed: 0,
            pending: 1,
            neutral: 0
          }
        })
      )
    ).toMatchObject({
      label: 'Checking',
      directMergeAvailable: false
    })
  })

  it('allows direct merge when GitHub mergeability is unavailable but checks have passed', () => {
    expect(
      presentGitHubPRMergeState({
        state: 'open',
        checksSummary: { state: 'success', total: 3, passed: 3, failed: 0, pending: 0, neutral: 0 }
      })
    ).toMatchObject({
      label: 'Checks passed',
      directMergeAvailable: true
    })
    expect(
      presentGitHubPRMergeState(
        pr({
          mergeable: 'UNKNOWN',
          mergeStateStatus: null,
          checksSummary: {
            state: 'success',
            total: 3,
            passed: 3,
            failed: 0,
            pending: 0,
            neutral: 0
          }
        })
      )
    ).toMatchObject({
      label: 'Checks passed',
      directMergeAvailable: true
    })
  })

  it('suppresses auto-merge actions for non-open PR states', () => {
    expect(
      presentGitHubPRMergeState(pr({ state: 'closed', mergeQueueRequired: true })).autoMergeAction
    ).toBeNull()
    expect(
      presentGitHubPRMergeState(pr({ state: 'merged', autoMergeEnabled: true })).autoMergeAction
    ).toBeNull()
    expect(
      presentGitHubPRMergeState(pr({ state: 'draft', mergeQueueRequired: true })).autoMergeAction
    ).toBeNull()
  })
})
