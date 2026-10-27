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
})
