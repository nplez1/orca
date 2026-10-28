import { describe, expect, it } from 'vitest'
import type { PRInfo } from '../../../../src/shared/github/pull-request-types'
import {
  presentPrMerge,
  resolveMobileAdminMergeBypassRequired,
  resolvePrActionAvailability
} from './pr-actions-state'

describe('resolvePrActionAvailability', () => {
  it('offers Ready for review instead of Merge on drafts, like desktop', () => {
    expect(resolvePrActionAvailability('draft')).toMatchObject({
      canMerge: false,
      canMarkReady: true,
      canClose: true
    })
    expect(resolvePrActionAvailability('open')).toMatchObject({
      canMerge: true,
      canMarkReady: false,
      canClose: true
    })
  })
})

describe('presentPrMerge', () => {
  const pr: PRInfo = {
    number: 202,
    title: 'API',
    state: 'open',
    url: 'https://example.test/202',
    checksStatus: 'success',
    updatedAt: '',
    mergeable: 'CONFLICTING'
  }
  const entry = {
    title: '',
    url: '',
    state: 'open' as const,
    checksStatus: 'success' as const,
    mergeable: 'MERGEABLE' as const
  }

  it('disables Merge with desktop copy when GitHub reports conflicts', () => {
    expect(presentPrMerge(pr, 'squash')).toMatchObject({
      enabled: false,
      label: 'Conflicts',
      hint: 'GitHub reports merge conflicts'
    })
  })

  it('lets a complete stack merge through, and names a blocking downstack PR', () => {
    const stack = {
      number: 51,
      position: 2,
      size: 3,
      baseRefName: 'main',
      entries: [
        { ...entry, position: 1, number: 201 },
        { ...entry, position: 2, number: 202 }
      ]
    }
    expect(presentPrMerge({ ...pr, stack }, 'squash')).toMatchObject({
      enabled: true,
      label: 'Merge through #202 · 2 PRs'
    })
    const blocked = {
      ...stack,
      entries: [{ ...entry, position: 1, number: 201, state: 'draft' as const }, stack.entries[1]]
    }
    expect(presentPrMerge({ ...pr, stack: blocked }, 'squash')).toMatchObject({
      enabled: false,
      hint: '#201 is still a draft.'
    })
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
