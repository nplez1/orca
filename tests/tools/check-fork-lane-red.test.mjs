import { describe, expect, it } from 'vitest'
import {
  describeVerdict,
  exitCodeFor,
  judgeLanes,
  lanePaths,
  newestVerdict
} from '../../local/check-fork-lane-red.mjs'

const NOW = Date.parse('2026-11-16T09:00:00Z')
const hoursAgo = (hours) => new Date(NOW - hours * 3600 * 1000).toISOString()

const run = (over = {}) => ({
  id: 1,
  status: 'completed',
  conclusion: 'success',
  event: 'push',
  createdAt: hoursAgo(2),
  url: 'https://example.test/run/1',
  ...over
})

const lane = (path, runs) =>
  judgeLanes({ lanes: [path], runsByLane: { [path]: runs } }, { now: NOW })

const GATES = '.github/workflows/fork-main-gates.yml'
const TAGS = '.github/workflows/fork-upstream-tags.yml'

describe('lanePaths', () => {
  it('judges the fork-owned required lanes that nothing else reports on', () => {
    expect(lanePaths()).toEqual([
      '.github/workflows/fork-main-gates.yml',
      '.github/workflows/fork-performance-contracts.yml',
      '.github/workflows/fork-pr-gates.yml',
      '.github/workflows/fork-release.yml',
      '.github/workflows/fork-upstream-tags.yml'
    ])
  })

  it('leaves out the lanes whose red is already reported, and every upstream lane', () => {
    expect(lanePaths()).not.toContain('.github/workflows/fork-main-tests.yml')
    expect(lanePaths()).not.toContain('.github/workflows/fork-ci-health.yml')
    expect(lanePaths()).not.toContain('.github/workflows/mobile.yml')
  })
})

describe('newestVerdict', () => {
  it('reads past a cancellation, because cancel-in-progress says nothing about the lane', () => {
    const runs = [run({ id: 2, conclusion: 'cancelled' }), run({ id: 1, conclusion: 'failure' })]

    expect(newestVerdict(runs).id).toBe(1)
  })

  it('answers null when every run is a non-verdict', () => {
    expect(newestVerdict([run({ conclusion: 'cancelled' }), run({ conclusion: 'stale' })])).toBe(
      null
    )
  })

  // The reviewed blocker: an unfinished run reports a null conclusion, and reading that as a verdict
  // marks the lane green — the silent green this file exists to end.
  it('reads past a run that has not finished, so a green cannot mask the red beneath it', () => {
    const verdict = lane(GATES, [
      run({ id: 3, status: 'in_progress', conclusion: null }),
      run({ id: 2, status: 'queued', conclusion: '' }),
      run({ id: 1, conclusion: 'failure' })
    ])

    expect(verdict.rows[0].state).toBe('red')
    expect(verdict.red).toHaveLength(1)
  })
})

describe('a lane red on main', () => {
  it('is red when its newest verdict failed', () => {
    const verdict = lane(GATES, [run({ conclusion: 'failure' })])

    expect(verdict.red.map((row) => row.path)).toEqual([GATES])
    expect(verdict.decisions).toEqual([])
    expect(verdict.green).toBe(0)
  })

  it('clears once a later verdict is green — the fix is the run, not the finding', () => {
    const verdict = lane(GATES, [run({ conclusion: 'success' }), run({ conclusion: 'failure' })])

    expect(verdict.red).toEqual([])
    expect(verdict.green).toBe(1)
  })

  it('counts timed_out and startup_failure as reds', () => {
    expect(lane(GATES, [run({ conclusion: 'timed_out' })]).red).toHaveLength(1)
    expect(lane(GATES, [run({ conclusion: 'startup_failure' })]).red).toHaveLength(1)
  })

  it('does not report a lane with no verdict to read', () => {
    const verdict = lane('.github/workflows/fork-pr-gates.yml', [])

    expect(verdict.red).toEqual([])
    expect(verdict.noRuns).toBe(1)
    expect(verdict.rows[0].state).toBe('no-runs')
  })
})

describe('a lane a person has to decide', () => {
  it('is a decision, not a delegated red', () => {
    const verdict = lane(TAGS, [run({ conclusion: 'failure' })])

    expect(verdict.decisions.map((row) => row.path)).toEqual([TAGS])
    expect(verdict.red).toEqual([])
  })
})

describe('a lane only a dispatch re-runs', () => {
  it('stays a delegable red but says a merge does not clear it', () => {
    const verdict = lane('.github/workflows/fork-release.yml', [run({ conclusion: 'failure' })])

    expect(verdict.red).toHaveLength(1)
    expect(describeVerdict(verdict)).toContain('DISPATCH: .github/workflows/fork-release.yml')
  })
})

describe('exitCodeFor', () => {
  it('reports 1 for a red a scoped fix can clear, and 0 when nothing is red', () => {
    expect(exitCodeFor(lane(GATES, [run({ conclusion: 'failure' })]))).toBe(1)
    expect(exitCodeFor(lane(GATES, [run()]))).toBe(0)
  })

  it('reports 3 once a decision is present, even beside a delegable red', () => {
    const verdict = judgeLanes(
      {
        lanes: [GATES, TAGS],
        runsByLane: {
          [GATES]: [run({ conclusion: 'failure' })],
          [TAGS]: [run({ conclusion: 'failure' })]
        }
      },
      { now: NOW }
    )

    expect(verdict.red).toHaveLength(1)
    expect(verdict.decisions).toHaveLength(1)
    expect(exitCodeFor(verdict)).toBe(3)
  })
})

describe('describeVerdict', () => {
  it('says PASS and counts the lanes it could not judge', () => {
    const verdict = judgeLanes(
      {
        lanes: [GATES, '.github/workflows/fork-pr-gates.yml'],
        runsByLane: { [GATES]: [run()], '.github/workflows/fork-pr-gates.yml': [] }
      },
      { now: NOW }
    )

    expect(describeVerdict(verdict).split('\n')[0]).toBe(
      'fork lanes: PASS — 1 green on main, 1 with no verdict to read'
    )
  })

  it('names the decision and states that nothing is delegated', () => {
    const text = describeVerdict(
      lane(TAGS, [run({ conclusion: 'failure', createdAt: hoursAgo(5) })])
    )

    expect(text.split('\n')[0]).toBe('fork lanes: ATTENTION — 1 red on main (oldest verdict 5h)')
    expect(text).toContain('DECISION: .github/workflows/fork-upstream-tags.yml')
    expect(text).toContain('withholds `agent:auto`')
  })

  it('leaves the age unknown rather than printing NaN when a run carries no timestamp', () => {
    const text = describeVerdict(lane(GATES, [run({ conclusion: 'failure', createdAt: null })]))

    expect(text).not.toContain('NaN')
    expect(text.split('\n')[0]).toBe('fork lanes: ATTENTION — 1 red on main')
  })

  it('carries the run url so the reader does not have to search for it', () => {
    const text = describeVerdict(lane(GATES, [run({ conclusion: 'failure' })]))

    expect(text).toContain('https://example.test/run/1')
  })
})
