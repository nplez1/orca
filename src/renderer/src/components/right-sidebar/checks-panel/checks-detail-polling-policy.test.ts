import { describe, expect, it } from 'vitest'
import type { PRCheckDetail } from '../../../../../shared/github/check-types'
import {
  ChecksDetailPollingPolicy,
  detailedChecksStatus,
  rollupReportsUnseenRun
} from './checks-detail-polling-policy'

describe('detailed checks refresh policy', () => {
  it.each([
    { status: 'queued', conclusion: null },
    { status: 'in_progress', conclusion: null },
    { status: 'completed', conclusion: 'pending' },
    { status: 'completed', conclusion: 'action_required' },
    { status: 'completed', conclusion: null }
  ] satisfies Pick<PRCheckDetail, 'status' | 'conclusion'>[])(
    'continues merged checks for $status / $conclusion',
    (check) => {
      const policy = new ChecksDetailPollingPolicy()
      policy.accept([{ name: 'Build', url: null, ...check }])
      expect(policy.delayMs('merged', 'success', 60_000)).toBe(60_000)
    }
  )

  it.each(['success', 'failure', 'neutral', 'cancelled', 'timed_out', 'skipped'] as const)(
    'stops merged details after %s even if the aggregate remains pending',
    (conclusion) => {
      const policy = new ChecksDetailPollingPolicy()
      policy.accept([{ name: 'Build', url: null, status: 'completed', conclusion }])
      expect(policy.delayMs('merged', 'pending', 60_000)).toBeNull()
    }
  )

  it.each(['success', 'failure', 'neutral'] as const)(
    'stops successful empty details with a settled %s aggregate',
    (aggregate) => {
      const policy = new ChecksDetailPollingPolicy()
      policy.accept([])
      expect(policy.delayMs('merged', aggregate, 120_000)).toBeNull()
    }
  )

  it('retries empty details when the aggregate is pending or unknown and backs off errors', () => {
    const policy = new ChecksDetailPollingPolicy()
    expect(detailedChecksStatus([])).toBeUndefined()
    policy.accept([])
    expect(policy.delayMs('merged', 'pending', 120_000)).toBe(120_000)
    expect(policy.delayMs('merged', undefined, 120_000)).toBe(120_000)
    policy.fail()
    expect(policy.delayMs('merged', 'success', 240_000)).toBe(240_000)
  })

  it('keeps an unfinished run on the focused loop, easing off only while its rows do not move', () => {
    const policy = new ChecksDetailPollingPolicy()
    const queued: PRCheckDetail[] = [
      { name: 'Build', url: null, status: 'queued', conclusion: null }
    ]
    policy.accept(queued)
    expect(policy.delayMs('open', 'neutral', 120_000)).toBe(10_000)
    policy.accept(queued)
    expect(policy.delayMs('open', 'neutral', 120_000)).toBe(20_000)
    policy.accept(queued)
    expect(policy.delayMs('open', 'neutral', 120_000)).toBe(30_000)
    policy.accept(queued)
    expect(policy.delayMs('open', 'neutral', 120_000)).toBe(30_000)
    // Progress resets it: the focused loop is back on the next read.
    policy.accept([{ name: 'Build', url: null, status: 'in_progress', conclusion: null }])
    expect(policy.delayMs('open', 'neutral', 120_000)).toBe(10_000)
  })

  it('does not treat an approval-pending suite as a live run', () => {
    const policy = new ChecksDetailPollingPolicy()
    policy.accept([
      { name: 'Deploy', url: null, status: 'completed', conclusion: 'action_required' }
    ])
    expect(policy.delayMs('open', 'pending', 60_000)).toBe(60_000)
  })

  it('leaves a settled open review on the coarser cadence and its backoff', () => {
    const policy = new ChecksDetailPollingPolicy()
    policy.accept([{ name: 'Build', url: null, status: 'completed', conclusion: 'success' }])
    expect(policy.delayMs('open', 'success', 60_000)).toBe(60_000)
    expect(policy.delayMs('open', 'success', 120_000)).toBe(120_000)
  })

  it('still backs off a failing focused panel', () => {
    const policy = new ChecksDetailPollingPolicy()
    policy.accept([{ name: 'Build', url: null, status: 'queued', conclusion: null }])
    policy.fail()
    expect(policy.failed).toBe(true)
    expect(policy.delayMs('open', 'pending', 60_000)).toBe(60_000)
    expect(policy.delayMs('open', 'pending', 240_000)).toBe(240_000)
    policy.accept([])
    expect(policy.failed).toBe(false)
  })

  it.each([
    ['success', 'pending', true],
    ['success', 'failure', true],
    ['neutral', 'failure', true],
    ['success', 'success', false],
    ['pending', 'success', false],
    ['pending', 'pending', false],
    ['failure', 'failure', false]
  ] as const)('treats %s rows against a %s rollup as news: %s', (displayed, rollup, expected) => {
    expect(rollupReportsUnseenRun(displayed, rollup)).toBe(expected)
  })

  it('has no opinion about a panel with no rows yet', () => {
    expect(rollupReportsUnseenRun(null, 'pending')).toBe(false)
    expect(rollupReportsUnseenRun(null, 'failure')).toBe(false)
  })
})
