import { describe, expect, it } from 'vitest'
import { judgeLiveness } from '../../local/check-nightly-liveness.mjs'

const NOW = Date.parse('2026-10-26T12:00:00Z')
const hoursAgo = (h) => new Date(NOW - h * 3600_000).toISOString()
const run = (over = {}) => ({
  databaseId: 1,
  status: 'completed',
  conclusion: 'success',
  createdAt: hoursAgo(2),
  headSha: '8da9849c43aa',
  event: 'schedule',
  ...over
})

describe('nightly liveness', () => {
  it('fails when the workflow has never run, rather than reading as green', () => {
    expect(judgeLiveness([], NOW)).toMatchObject({ ok: false, code: 1 })
  })

  it('passes on a recent green scheduled run', () => {
    expect(judgeLiveness([run()], NOW)).toMatchObject({ ok: true, code: 0, runsInLastDay: 1 })
  })

  it('fails when the newest run is older than two schedule slots', () => {
    const verdict = judgeLiveness([run({ createdAt: hoursAgo(40) })], NOW)
    expect(verdict).toMatchObject({ ok: false, code: 1 })
    expect(verdict.summary).toMatch(/cron is not firing/)
  })

  it('names a wedged run instead of calling it slow', () => {
    const verdict = judgeLiveness(
      [run({ status: 'queued', conclusion: null, createdAt: hoursAgo(17) })],
      NOW
    )
    expect(verdict).toMatchObject({ ok: false, code: 1 })
    expect(verdict.summary).toMatch(/wedged/)
  })

  it('tolerates a run that is genuinely in flight', () => {
    expect(
      judgeLiveness([run({ status: 'in_progress', conclusion: null, createdAt: hoursAgo(1) })], NOW)
    ).toMatchObject({
      ok: true,
      code: 0
    })
  })

  it('fails on a red run even when it is fresh', () => {
    expect(judgeLiveness([run({ conclusion: 'failure' })], NOW)).toMatchObject({
      ok: false,
      code: 1
    })
  })

  it('reads a cancelled run as no verdict, not as red', () => {
    const verdict = judgeLiveness([run({ conclusion: 'cancelled' })], NOW)
    expect(verdict).toMatchObject({ ok: false, code: 1, verdictRunId: null })
    expect(verdict.summary).not.toMatch(/red/)
    expect(verdict.summary).toMatch(/no completed run has produced a verdict/)
  })

  it('does not let a cancelled run hide the green run it followed', () => {
    const verdict = judgeLiveness(
      [
        run({ databaseId: 22, conclusion: 'cancelled', createdAt: hoursAgo(19) }),
        run({ databaseId: 21, createdAt: hoursAgo(20) })
      ],
      NOW
    )
    expect(verdict).toMatchObject({ ok: true, code: 0, verdictRunId: 21, verdictAgeHours: 20 })
    expect(verdict.summary).toMatch(/nightly green/)
    expect(verdict.summary).toMatch(/carried no verdict: cancelled/)
  })

  it('fails when every run for days carries no verdict', () => {
    const verdict = judgeLiveness(
      [
        run({ databaseId: 32, conclusion: 'cancelled', createdAt: hoursAgo(1) }),
        run({ databaseId: 31, conclusion: 'cancelled', createdAt: hoursAgo(25) })
      ],
      NOW
    )
    expect(verdict).toMatchObject({ ok: false, code: 1, verdictRunId: null })
    expect(verdict.summary).toMatch(/no completed run has produced a verdict/)
  })

  it('fails when the schedule fires but the last verdict is stale', () => {
    const verdict = judgeLiveness(
      [
        run({ databaseId: 42, conclusion: 'cancelled', createdAt: hoursAgo(2) }),
        run({ databaseId: 41, createdAt: hoursAgo(50) })
      ],
      NOW
    )
    expect(verdict).toMatchObject({ ok: false, code: 1, verdictAgeHours: 50 })
    expect(verdict.summary).toMatch(/newest verdict is 50h old/)
  })
})
