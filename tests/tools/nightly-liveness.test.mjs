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

  it('does not let an in-flight run answer for the backstop on its own', () => {
    // Why: it has produced no verdict, so reporting PASS hands out up to WEDGED_AFTER_H of green on
    // the strength of a run that has not finished — after a red night, exactly when it matters.
    const verdict = judgeLiveness(
      [run({ status: 'in_progress', conclusion: null, createdAt: hoursAgo(1) })],
      NOW
    )
    expect(verdict).toMatchObject({ ok: false, code: 1 })
    expect(verdict.summary).toMatch(/nothing has actually run the suite/)
  })

  it('passes on an in-flight run when a recent verdict is green', () => {
    const verdict = judgeLiveness(
      [
        run({ databaseId: 12, status: 'in_progress', conclusion: null, createdAt: hoursAgo(1) }),
        run({ databaseId: 11, conclusion: 'success', createdAt: hoursAgo(25) })
      ],
      NOW
    )
    expect(verdict).toMatchObject({ ok: true, code: 0, verdictRunId: 11 })
    expect(verdict.summary).toMatch(/has no verdict yet/)
  })

  it('still reports a red run when a re-run is in flight over it', () => {
    const verdict = judgeLiveness(
      [
        run({ databaseId: 24, status: 'in_progress', conclusion: null, createdAt: hoursAgo(1) }),
        run({ databaseId: 23, conclusion: 'failure', createdAt: hoursAgo(20) })
      ],
      NOW
    )
    expect(verdict).toMatchObject({ ok: false, code: 1 })
    expect(verdict.summary).toMatch(/red \(failure\)/)
  })

  it('treats pending as in flight, because pending is the concurrency-blocked state', () => {
    const verdict = judgeLiveness(
      [run({ status: 'pending', conclusion: null, createdAt: hoursAgo(9) })],
      NOW
    )
    expect(verdict).toMatchObject({ ok: false, code: 1 })
    expect(verdict.summary).toMatch(/wedged/)
  })

  it('does not let a cancelled run cover an older red one', () => {
    const verdict = judgeLiveness(
      [
        run({ databaseId: 34, conclusion: 'cancelled', createdAt: hoursAgo(2) }),
        run({ databaseId: 33, conclusion: 'failure', createdAt: hoursAgo(20) })
      ],
      NOW
    )
    expect(verdict).toMatchObject({ ok: false, code: 1, verdictRunId: 33 })
    expect(verdict.summary).toMatch(/red \(failure\)/)
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
    expect(verdict.summary).toMatch(
      /no completed run in the fetched history has produced a verdict/
    )
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
    expect(verdict.summary).toMatch(
      /no completed run in the fetched history has produced a verdict/
    )
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
