import { describe, expect, it } from 'vitest'
import {
  WAIT_LIMIT_H,
  describeVerdict,
  judgeQueue,
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

    expect(describeVerdict(verdict)).toContain('CONCURRENCY')
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
