import { rmSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  WAIT_LIMIT_H,
  describeVerdict,
  judgeQueue,
  readKnownGhosts,
  waitedHours
} from '../../local/check-queued-runs.mjs'

const NOW = Date.parse('2026-11-01T12:00:00Z')
const hoursAgo = (hours) => new Date(NOW - hours * 3600 * 1000).toISOString()

const run = (over = {}) => ({
  id: 1,
  name: 'Fork main unit tests',
  status: 'in_progress',
  created_at: hoursAgo(2),
  html_url: 'https://example.test/run/1',
  ...over
})

const judge = (runs, jobsByRun = {}) => judgeQueue({ runs, jobsByRun }, { now: NOW })

describe('waitedHours', () => {
  it('answers null for a missing timestamp rather than treating it as now', () => {
    expect(waitedHours(null, NOW)).toBe(null)
    expect(waitedHours(undefined, NOW)).toBe(null)
    expect(Math.round(waitedHours(hoursAgo(3), NOW))).toBe(3)
  })
})

describe('a job waiting inside a run that reads in_progress', () => {
  it('is reported, because the run-level status says nothing about it', () => {
    const waiting = run()
    const verdict = judge([waiting], {
      [waiting.id]: [
        {
          name: 'test / tests',
          status: 'in_progress',
          started_at: hoursAgo(1.5),
          labels: ['ubuntu']
        },
        {
          name: 'relay integration',
          status: 'queued',
          started_at: null,
          created_at: hoursAgo(17.5),
          labels: ['blacksmith-4vcpu-ubuntu-2404']
        }
      ]
    })

    expect(verdict.waited).toHaveLength(1)
    expect(verdict.waited[0]).toMatchObject({
      where: 'job',
      jobName: 'relay integration',
      labels: ['blacksmith-4vcpu-ubuntu-2404']
    })
    expect(describeVerdict(verdict)).toContain('relay integration [blacksmith-4vcpu-ubuntu-2404]')
  })

  it('is not a finding while it is still inside the limit', () => {
    const waiting = run()
    const verdict = judge([waiting], {
      [waiting.id]: [
        { name: 'cold start', status: 'queued', started_at: null, created_at: hoursAgo(0.5) }
      ]
    })

    expect(verdict.waited).toEqual([])
    expect(verdict.inFlight).toBe(1)
  })
})

describe('a run waiting for a runner', () => {
  it('is reported once at run level, not once per queued job', () => {
    const waiting = run({ status: 'queued', created_at: hoursAgo(4) })
    const verdict = judge([waiting], {
      [waiting.id]: [
        { name: 'a', status: 'queued', started_at: null, created_at: hoursAgo(4) },
        { name: 'b', status: 'queued', started_at: null, created_at: hoursAgo(4) }
      ]
    })

    expect(verdict.waited).toHaveLength(1)
    expect(verdict.waited[0].where).toBe('run')
  })

  it('is reported as a record GitHub will not cancel when it has no jobs at all', () => {
    const ghost = run({ status: 'queued', created_at: hoursAgo(593) })
    const verdict = judge([ghost], { [ghost.id]: [] })

    expect(verdict.waited[0].where).toBe('ghost')
    const text = describeVerdict(verdict)
    expect(text).toContain('NO JOBS')
    expect(text).toContain('delete it in the Actions UI')
    expect(text).not.toContain('provision the runner')
  })

  it('does not call it a ghost when its jobs were never fetched', () => {
    const waiting = run({ status: 'queued', created_at: hoursAgo(4) })
    const verdict = judge([waiting], {})

    expect(verdict.waited[0].where).toBe('run')
  })
})

describe('the verdict line', () => {
  it('ignores completed runs entirely', () => {
    const verdict = judge([run({ status: 'completed', conclusion: 'success' })])

    expect(verdict).toMatchObject({ waited: [], inFlight: 0, oldestHours: null })
    expect(describeVerdict(verdict)).toContain('PASS')
  })

  it('keeps waiting and in-flight separate, so a quiet queue is not a busy one', () => {
    const busy = run({ id: 2, created_at: hoursAgo(0.2) })
    const verdict = judge([busy])

    expect(verdict.inFlight).toBe(1)
    expect(describeVerdict(verdict)).toContain(`nothing waiting past ${WAIT_LIMIT_H}h`)
    expect(describeVerdict(verdict)).toContain('1 in-flight run(s)')
  })

  it('names the oldest wait, which is what makes it actionable by hand', () => {
    const older = run({ id: 3, status: 'queued', created_at: hoursAgo(9) })
    const verdict = judge([older], { [older.id]: [] })

    expect(describeVerdict(verdict)).toContain('oldest 9h')
  })
})

describe('the remedy, which is not always a runner', () => {
  it('sends a `waiting` job to the protection rule, not to a runner label', () => {
    const waiting = run()
    const verdict = judge([waiting], {
      [waiting.id]: [
        { name: 'awaiting approval', status: 'waiting', started_at: null, created_at: hoursAgo(3) }
      ]
    })

    const text = describeVerdict(verdict)
    expect(text).toContain('ENVIRONMENT')
    expect(text).not.toContain('RUNNER:')
  })

  it('names the concurrency group when a run is pending behind another', () => {
    const pending = run({ status: 'pending', created_at: hoursAgo(5) })
    const verdict = judge([pending], { [pending.id]: [] })

    const text = describeVerdict(verdict)
    expect(text).toContain('CONCURRENCY')
    // The row is tagged for what it is waiting on, not lumped in as a runner queue.
    expect(text).toContain('PENDING')
  })

  it('does not blame a runner label for a queued run that has one', () => {
    const queued = run({ status: 'queued', created_at: hoursAgo(6) })
    const verdict = judge([queued], {
      [queued.id]: [{ name: 'job', status: 'queued', started_at: null }]
    })

    expect(describeVerdict(verdict)).toContain('RUNNER:')
  })
})

describe('the age of a re-run', () => {
  it('is counted from the current attempt, not from when the run was first created', () => {
    const rerun = run({ created_at: hoursAgo(200), run_started_at: hoursAgo(2) })
    const verdict = judge([rerun], {
      [rerun.id]: [{ name: 'cold', status: 'queued', started_at: null }]
    })

    expect(verdict.waited[0].ageHours).toBeCloseTo(2, 5)
  })
})

// Captured with `gh api /repos/nplez1/orca/actions/runs/40308443374/jobs` on 2026-11-01, with the
// status it carried while it was waiting. This is the payload that proved the first version of this
// check could never fire: `started_at` is set on a job that no runner ever claimed.
const RELAY_JOB_AS_IT_WAITED = {
  name: 'test / relay integration node 24',
  status: 'queued',
  started_at: hoursAgo(17.5),
  created_at: hoursAgo(17.5),
  runner_name: '',
  runner_id: 0
}

describe('a job that was queued, measured against the real payload', () => {
  it('reports the 2026-10-26 relay job, whose started_at is set with no runner behind it', () => {
    const stuck = run({ id: 9, created_at: hoursAgo(18), run_started_at: hoursAgo(18) })
    const verdict = judge([stuck], { [stuck.id]: [RELAY_JOB_AS_IT_WAITED] })

    expect(verdict.waited).toHaveLength(1)
    expect(verdict.waited[0]).toMatchObject({
      where: 'job',
      jobName: 'test / relay integration node 24'
    })
    expect(Math.round(verdict.waited[0].ageHours)).toBe(18)
  })

  it('does not report a queued job that already has a runner assigned', () => {
    const assigned = {
      ...RELAY_JOB_AS_IT_WAITED,
      runner_name: 'GitHub Actions 1000004517',
      runner_id: 12
    }
    const running = run()
    const verdict = judge([running], { [running.id]: [assigned] })

    expect(verdict.waited).toEqual([])
  })

  it('ignores a job that is already running, whatever its runner fields say', () => {
    const running = run()
    const verdict = judge([running], {
      [running.id]: [
        { name: 'shard', status: 'in_progress', started_at: hoursAgo(4), created_at: hoursAgo(4) }
      ]
    })

    expect(verdict.waited).toEqual([])
  })
})

describe('a job whose dependencies have not finished', () => {
  it('is not reported, because its record is only created when it becomes eligible', () => {
    // Measured on run 40308443374: the plan job started at 10:34:21 and the shards that need it were
    // created at 10:35:26 — created_at tracks eligibility, not the run's start, so an old run with a
    // freshly eligible job is not a queue wait.
    const longRun = run({ created_at: hoursAgo(6), run_started_at: hoursAgo(6) })
    const justEligible = {
      name: 'build',
      status: 'queued',
      created_at: hoursAgo(0.2),
      started_at: hoursAgo(0.2),
      runner_name: '',
      runner_id: 0
    }
    const verdict = judge([longRun], { [longRun.id]: [justEligible] })

    expect(verdict.waited).toEqual([])
  })
})

describe('a zero-job run that cannot be cleared', () => {
  const ghostRun = () => run({ id: 77, status: 'queued', created_at: hoursAgo(593) })

  it('is acknowledged rather than reported when its id is listed', () => {
    const ghost = ghostRun()
    const verdict = judgeQueue(
      { runs: [ghost], jobsByRun: { [ghost.id]: [] }, knownGhosts: new Set([ghost.id]) },
      { now: NOW }
    )

    expect(verdict.waited).toEqual([])
    expect(verdict.acknowledged).toHaveLength(1)
    expect(verdict.staleAcknowledged).toEqual([])

    const text = describeVerdict(verdict)
    expect(text).toContain('PASS')
    expect(text).toContain('acknowledged')
    expect(text).toContain('delete')
  })

  it('still reports a zero-job run that is not listed', () => {
    const ghost = ghostRun()
    const verdict = judgeQueue(
      { runs: [ghost], jobsByRun: { [ghost.id]: [] }, knownGhosts: new Set([999]) },
      { now: NOW }
    )

    expect(verdict.waited[0].where).toBe('ghost')
    expect(verdict.staleAcknowledged).toEqual([999])
    expect(describeVerdict(verdict)).toContain('remove   999')
  })

  it('reads a missing manifest as nothing acknowledged, and a broken one as unreadable', () => {
    expect(readKnownGhosts('/nonexistent/queued-known-ghosts.json')).toEqual(new Set())
    const broken = new URL('./queued-known-ghosts.broken.json', import.meta.url).pathname
    writeFileSync(broken, '{ not json')
    try {
      expect(readKnownGhosts(broken)).toHaveProperty('error')
    } finally {
      rmSync(broken)
    }
  })

  it('keeps an acknowledged ghost distinguishable from a real finding on a red day', () => {
    const ghost = ghostRun()
    const stuck = run({ id: 90, created_at: hoursAgo(5), run_started_at: hoursAgo(5) })
    const verdict = judgeQueue(
      {
        runs: [ghost, stuck],
        jobsByRun: {
          [ghost.id]: [],
          [stuck.id]: [RELAY_JOB_AS_IT_WAITED]
        },
        knownGhosts: new Set([ghost.id])
      },
      { now: NOW }
    )

    const text = describeVerdict(verdict)
    expect(text).toContain('ATTENTION — 1 waiting')
    expect(text).toContain('ACKED')
    expect(text).toContain('not counted above')
  })

  it('ships a manifest whose entry matches the run it documents', () => {
    const ids = readKnownGhosts()

    expect(ids).toBeInstanceOf(Set)
    expect([...ids]).toContain(37640199177)
  })
})
