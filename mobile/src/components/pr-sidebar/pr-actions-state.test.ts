import { describe, expect, it } from 'vitest'
import type { PRInfo } from '../../../../src/shared/github/pull-request-types'
import {
  resolveMobileAdminMergeBypassRequired,
  resolveMobilePrMergeMethod,
  resolvePrActionAvailability
} from './pr-actions-state'

describe('resolvePrActionAvailability', () => {
  it('merged: only unlink', () => {
    expect(resolvePrActionAvailability('merged')).toEqual({
      canMerge: false,
      canAutoMerge: false,
      canClose: false,
      canReopen: false,
      canUnlink: true
    })
  })

  it('closed: reopen + unlink, no merge', () => {
    const a = resolvePrActionAvailability('closed')
    expect(a.canReopen).toBe(true)
    expect(a.canUnlink).toBe(true)
    expect(a.canMerge).toBe(false)
    expect(a.canClose).toBe(false)
  })

  it('open and draft: merge/auto-merge/close allowed', () => {
    for (const state of ['open', 'draft'] as const) {
      const a = resolvePrActionAvailability(state)
      expect(a.canMerge).toBe(true)
      expect(a.canAutoMerge).toBe(true)
      expect(a.canClose).toBe(true)
      expect(a.canReopen).toBe(false)
    }
  })
})

describe('resolveMobilePrMergeMethod', () => {
  it('uses squash when repository settings are unavailable', () => {
    expect(resolveMobilePrMergeMethod(undefined)).toBe('squash')
  })

  it('uses the repository default when it is allowed', () => {
    expect(
      resolveMobilePrMergeMethod({
        defaultMethod: 'rebase',
        allowedMethods: { merge: false, squash: true, rebase: true }
      })
    ).toBe('rebase')
  })

  it('falls back to an allowed method when the default is disabled', () => {
    expect(
      resolveMobilePrMergeMethod({
        defaultMethod: 'rebase',
        allowedMethods: { merge: false, squash: true, rebase: false }
      })
    ).toBe('squash')
  })
})

function pr(overrides: Partial<PRInfo> = {}): PRInfo {
  return {
    number: 7,
    title: 'PR',
    state: 'open',
    url: 'https://github.com/stablyai/orca/pull/7',
    checksStatus: 'success',
    updatedAt: '2026-04-01T00:00:00Z',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'UNSTABLE',
    // Known, not merely not-true: an unknown queue status must not be bypassed.
    mergeQueueRequired: false,
    ...overrides
  }
}

describe('resolveMobileAdminMergeBypassRequired', () => {
  it('does not ask for a bypass when nobody has said the viewer may take one', () => {
    expect(resolveMobileAdminMergeBypassRequired(pr({ reviewDecision: 'REVIEW_REQUIRED' }))).toBe(
      false
    )
    expect(
      resolveMobileAdminMergeBypassRequired(
        pr({ reviewDecision: 'REVIEW_REQUIRED', viewerCanMergeAsAdmin: false })
      )
    ).toBe(false)
  })

  it('asks for a bypass on an unmet review gate the viewer may waive', () => {
    expect(
      resolveMobileAdminMergeBypassRequired(
        pr({ reviewDecision: 'REVIEW_REQUIRED', viewerCanMergeAsAdmin: true })
      )
    ).toBe(true)
    expect(
      resolveMobileAdminMergeBypassRequired(
        pr({ reviewDecision: 'CHANGES_REQUESTED', viewerCanMergeAsAdmin: true })
      )
    ).toBe(true)
  })

  it('keeps the question to the cases a bypass can actually answer', () => {
    const bypassable: Partial<PRInfo> = {
      viewerCanMergeAsAdmin: true,
      reviewDecision: 'REVIEW_REQUIRED',
      mergeQueueRequired: false
    }
    expect(resolveMobileAdminMergeBypassRequired(pr({ ...bypassable, state: 'draft' }))).toBe(false)
    expect(
      resolveMobileAdminMergeBypassRequired(pr({ ...bypassable, mergeable: 'CONFLICTING' }))
    ).toBe(false)
    // Why: the one parameter that carries a bypass to the host also skips the merge queue, and an
    // unrun or rate-limited merge-metadata probe leaves the queue status unknown rather than false.
    for (const mergeQueueRequired of [true, null, undefined] as const) {
      expect(resolveMobileAdminMergeBypassRequired(pr({ ...bypassable, mergeQueueRequired }))).toBe(
        false
      )
    }
    // Why: BLOCKED can mean required checks are failing, which the confirmation never covers.
    expect(
      resolveMobileAdminMergeBypassRequired(pr({ ...bypassable, mergeStateStatus: 'BLOCKED' }))
    ).toBe(false)
    expect(
      resolveMobileAdminMergeBypassRequired(
        pr({ viewerCanMergeAsAdmin: true, reviewDecision: 'APPROVED' })
      )
    ).toBe(false)
  })
})
