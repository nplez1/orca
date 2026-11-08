import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  diagnoseSlot,
  judgeLiveness,
  missedSchedule,
  runsNeedingJobs,
  verdictOf
} from '../../local/check-nightly-liveness.mjs'

const NOW = Date.parse('2026-10-26T12:00:00Z')
const hoursAgo = (h) => new Date(NOW - h * 3600_000).toISOString()
const run = (over = {}) => ({
  databaseId: 1,
  status: 'completed',
  conclusion: 'success',
  createdAt: hoursAgo(2),
  headSha: '8da9849c43aa',
  event: 'schedule',
  attempt: 1,
  ...over
})
const shard = (name, conclusion) => ({ name, conclusion })

// The 2026-10-26 schedule, as GitHub actually reports it: run-level `cancelled`, four red shards.
const WEDGED_RUN_ID = 40308443374
const wedgedRun = () =>
  run({ databaseId: WEDGED_RUN_ID, conclusion: 'cancelled', createdAt: hoursAgo(17) })
const wedgedJobs = [
  shard('plan', 'success'),
  shard('test / tests node 24 4/5', 'success'),
  shard('test / tests node 24 1/5', 'failure'),
  shard('test / tests node 24 2/5', 'failure'),
  shard('test / tests node 24 3/5', 'failure'),
  shard('test / tests node 24 5/5', 'failure'),
  shard('test / relay integration node 24', 'cancelled')
]

describe('nightly liveness', () => {
  it('fails when the workflow has never run, rather than reading as green', () => {
    expect(judgeLiveness([], NOW)).toMatchObject({ ok: false, code: 1 })
  })

  it('passes on a recent green scheduled run', () => {
    expect(judgeLiveness([run()], NOW)).toMatchObject({ ok: true, code: 0, runsInLastDay: 1 })
  })

  it('fails when the newest scheduled run is older than two schedule slots', () => {
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

  it('reads a cancelled run as no verdict, not as red, when its jobs say nothing', () => {
    const verdict = judgeLiveness([run({ conclusion: 'cancelled' })], NOW)
    expect(verdict).toMatchObject({ ok: false, code: 1, verdictRunId: null })
    expect(verdict.summary).not.toMatch(/red/)
    expect(verdict.summary).toMatch(
      /no completed run in the fetched history has produced a verdict/
    )
  })

  it('reads a cancelled run with failed shards as RED, which is what actually happened', () => {
    // The bug this case exists for: 40308443374 is `cancelled` at the run level and failed four of
    // five shards. Treating the cancel as "no verdict" hid them, so a green run before it would have
    // reported PASS on a night that went red.
    const verdict = judgeLiveness([wedgedRun()], NOW, { jobs: { [WEDGED_RUN_ID]: wedgedJobs } })
    expect(verdict).toMatchObject({
      ok: false,
      code: 1,
      verdictRunId: WEDGED_RUN_ID,
      runId: WEDGED_RUN_ID
    })
    expect(verdict.failedJobs).toHaveLength(4)
    expect(verdict.summary).toMatch(/red \(failure\)/)
    expect(verdict.summary).toMatch(/4 of its jobs failed/)
  })

  it('does not let that red cancelled run be excused by an older green one', () => {
    const verdict = judgeLiveness(
      [wedgedRun(), run({ databaseId: 21, createdAt: hoursAgo(20) })],
      NOW,
      { jobs: { [WEDGED_RUN_ID]: wedgedJobs } }
    )
    expect(verdict).toMatchObject({ ok: false, code: 1, verdictRunId: WEDGED_RUN_ID })
  })

  it('leaves a cancelled run verdict-less when every job that finished passed', () => {
    const verdict = judgeLiveness(
      [
        run({ databaseId: 51, conclusion: 'cancelled' }),
        run({ databaseId: 50, createdAt: hoursAgo(20) })
      ],
      NOW,
      {
        jobs: {
          51: [shard('plan', 'success'), shard('test / tests node 24 1/5', 'success')]
        }
      }
    )
    expect(verdict).toMatchObject({ ok: true, code: 0, verdictRunId: 50 })
  })

  it('counts a timed-out job as red, because a timeout is a failure the cancel can hide', () => {
    expect(verdictOf(run({ conclusion: 'cancelled' }), [shard('plan', 'timed_out')])).toEqual({
      conclusion: 'failure',
      failedJobs: ['plan']
    })
  })

  it('normalises an unfinished run conclusion of "" to null so --json keeps one shape', () => {
    const verdict = judgeLiveness(
      [run({ status: 'in_progress', conclusion: '', createdAt: hoursAgo(1) })],
      NOW
    )
    expect(verdict.conclusion).toBeNull()
    expect(verdict.summary).not.toMatch(/was ;/)
  })

  it('measures a wedge from startedAt, so a re-run is not judged by the original failure', () => {
    // GitHub keeps databaseId and createdAt across `gh run rerun`; only attempt and startedAt move.
    const verdict = judgeLiveness(
      [
        run({
          databaseId: 61,
          status: 'in_progress',
          conclusion: null,
          createdAt: hoursAgo(10),
          startedAt: hoursAgo(1),
          attempt: 2
        })
      ],
      NOW
    )
    expect(verdict).toMatchObject({ ok: false, code: 1 })
    expect(verdict.summary).not.toMatch(/wedged/)
    expect(verdict.summary).toMatch(/nothing has actually run the suite/)
  })

  it('still calls a re-run wedged when its own attempt has been stuck too long', () => {
    const verdict = judgeLiveness(
      [
        run({
          status: 'in_progress',
          conclusion: null,
          createdAt: hoursAgo(10),
          startedAt: hoursAgo(5),
          attempt: 2
        })
      ],
      NOW
    )
    expect(verdict.summary).toMatch(/wedged/)
    expect(verdict.summary).toMatch(/attempt 2/)
  })

  it('sorts unsorted history, since gh order is not something to rely on', () => {
    const verdict = judgeLiveness(
      [
        run({ databaseId: 2, conclusion: 'failure', createdAt: hoursAgo(20) }),
        run({ databaseId: 3 })
      ],
      NOW
    )
    expect(verdict).toMatchObject({ ok: true, code: 0, runId: 3, verdictRunId: 3 })
  })

  it('does not let a manual dispatch stand in for the cron', () => {
    const verdict = judgeLiveness(
      [
        run({ databaseId: 71, event: 'workflow_dispatch', createdAt: hoursAgo(1) }),
        run({ databaseId: 70, conclusion: 'failure', createdAt: hoursAgo(50) })
      ],
      NOW
    )
    expect(verdict).toMatchObject({ ok: false, code: 1, scheduleAgeHours: 50 })
    expect(verdict.summary).toMatch(/cron is not firing/)
  })

  it('counts only scheduled runs in the last day', () => {
    const verdict = judgeLiveness(
      [
        run({ databaseId: 81 }),
        run({ databaseId: 80, event: 'workflow_dispatch', createdAt: hoursAgo(3) }),
        run({ databaseId: 79, event: 'workflow_dispatch', createdAt: hoursAgo(4) }),
        run({ databaseId: 78, createdAt: hoursAgo(30) })
      ],
      NOW
    )
    expect(verdict.runsInLastDay).toBe(1)
  })

  it('cannot tell, rather than pass, when a run newer than the last pass was never inspected', () => {
    // The hole this closes: a green verdict from before a cancelled run, with that run's jobs
    // unread, is exactly the state that printed PASS on a night with four red shards.
    const verdict = judgeLiveness(
      [
        run({ databaseId: 92, conclusion: 'cancelled', createdAt: hoursAgo(6) }),
        run({ databaseId: 91, createdAt: hoursAgo(30) })
      ],
      NOW
    )
    expect(verdict).toMatchObject({ ok: false, code: 2, unreadRuns: 1 })
    expect(verdict.summary).toMatch(/cannot tell/)
    expect(verdict.summary).toMatch(/Not a pass/)
  })

  it('still reports red, not cannot-tell, when an unread run cannot rescue a red verdict', () => {
    const verdict = judgeLiveness(
      [
        run({ databaseId: 95, conclusion: 'cancelled', createdAt: hoursAgo(2) }),
        run({ databaseId: 94, conclusion: 'failure', createdAt: hoursAgo(20) })
      ],
      NOW
    )
    expect(verdict).toMatchObject({ ok: false, code: 1 })
    expect(verdict.summary).toMatch(/red \(failure\)/)
  })

  it('does not let a cancelled run hide the green run it followed', () => {
    const verdict = judgeLiveness(
      [
        run({ databaseId: 22, conclusion: 'cancelled', createdAt: hoursAgo(19) }),
        run({ databaseId: 21, createdAt: hoursAgo(20) })
      ],
      NOW,
      { jobs: { 22: [shard('plan', 'success')] } }
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

  it('says so when job detail could not be read, instead of quietly trusting the cancel', () => {
    const verdict = judgeLiveness([wedgedRun()], NOW, { jobReadError: 'gh: HTTP 502' })
    expect(verdict).toMatchObject({ ok: false, code: 1, jobReadError: 'gh: HTTP 502' })
    expect(verdict.summary).toMatch(/shard failures may be hidden/)
  })

  it('asks for jobs only on completed runs newer than the newest resolved verdict', () => {
    expect(
      runsNeedingJobs([
        run({ databaseId: 1, conclusion: 'cancelled', createdAt: hoursAgo(30) }),
        run({ databaseId: 2 }),
        run({ databaseId: 3, status: 'in_progress', conclusion: null, createdAt: hoursAgo(1) }),
        run({ databaseId: 4, conclusion: 'cancelled', createdAt: hoursAgo(2) })
      ])
    ).toEqual([4])
  })

  it('reads a verdict-less run created at the same moment as the verdict it must not override', () => {
    // Both sides of the boundary use >=, so a tie is inspected rather than skipped.
    expect(
      runsNeedingJobs([
        run({ databaseId: 7, createdAt: hoursAgo(24) }),
        run({ databaseId: 8, conclusion: 'cancelled', createdAt: hoursAgo(24) })
      ])
    ).toEqual([8])
  })
})

describe('why a slot went unanswered', () => {
  // 2026-11-06: GitHub turned Actions off for the whole repository to stop inherited upstream crons.
  // The 2026-11-07 slot produced no run, and nothing else in the repository ran for 34h either —
  // which the workflow-scoped run list cannot see, so the check could only blame the cron.
  const silentRun = () =>
    run({
      databaseId: 90,
      conclusion: 'failure',
      createdAt: new Date(NOW - 40 * 3600_000).toISOString()
    })
  const repoRun = (at, workflowName = 'Fork base gates', event = 'schedule') => ({
    createdAt: new Date(at).toISOString(),
    databaseId: 1,
    event,
    status: 'completed',
    workflowName
  })
  const HOUR_MS = 3600_000
  // NOW is 2026-10-26T12:00Z, so the slot a 40h-old nightly missed is 2026-10-25T04:53Z.
  const lastBeforeSlot = Date.parse('2026-10-24T18:09:57Z')
  const slot = Date.parse('2026-10-25T04:53:00Z')

  it('names the repository-level switch when nothing in the repository ran in the slot window', () => {
    const verdict = judgeLiveness([silentRun()], NOW, {
      repoRuns: [repoRun(lastBeforeSlot), repoRun(NOW - HOUR_MS, 'Fork CI health')]
    })
    expect(verdict).toMatchObject({ ok: false, code: 1, staleSchedule: true })
    // Two slots have come due; the newest one's window is still open at NOW, so the older is judged.
    expect(verdict.missedSlot).toBe('2026-10-25T04:53:00Z')
    expect(verdict.missedSlots).toBe(2)
    expect(verdict.repoRunsInWindow).toBe(0)
    expect(verdict.summary).toMatch(/Actions switch was off or GitHub was down/)
    expect(verdict.summary).toMatch(/40\.8h of silence from 2026-10-24T18:09:57Z/)
    expect(verdict.summary).not.toMatch(/the cron is not firing/)
  })

  it('puts the fault back on this workflow when a scheduled run happened in the window', () => {
    const verdict = judgeLiveness([silentRun()], NOW, {
      repoRuns: [
        repoRun(lastBeforeSlot),
        repoRun(slot + 2 * HOUR_MS, 'Fork CI health'),
        repoRun(slot + 3 * HOUR_MS, 'Mobile Checks', 'pull_request')
      ]
    })
    expect(verdict.repoRunsInWindow).toBe(2)
    expect(verdict.summary).toMatch(/2 run\(s\) started inside/)
    expect(verdict.summary).toMatch(/at least one was scheduled/)
    expect(verdict.summary).toMatch(/Fork CI health, Mobile Checks/)
    expect(verdict.summary).toMatch(/this workflow's own schedule or enablement/)
  })

  it('blames the scheduler, not this workflow, when only unscheduled runs happened', () => {
    // Why: GitHub drops cron fires under load while still processing pushes, and no enablement of this
    // workflow explains a crons-wide silence — so "live" would point the triage at the wrong setting.
    const verdict = judgeLiveness([silentRun()], NOW, {
      repoRuns: [
        repoRun(lastBeforeSlot),
        repoRun(slot + 2 * HOUR_MS, 'Fork PR gates', 'pull_request'),
        repoRun(slot + 3 * HOUR_MS, 'Fork base gates', 'push')
      ]
    })
    expect(verdict.summary).toMatch(/none of them was scheduled/)
    expect(verdict.summary).toMatch(/no cron in the repository fired in that window either/)
    expect(verdict.summary).not.toMatch(/this workflow's own schedule or enablement/)
  })

  it('does not read a run that arrives after the window as proof the cron fired', () => {
    const verdict = judgeLiveness([silentRun()], NOW, {
      repoRuns: [repoRun(lastBeforeSlot), repoRun(slot + 20 * HOUR_MS, 'Fork CI health')]
    })
    expect(verdict.repoRunsInWindow).toBe(0)
    expect(verdict.summary).toMatch(/Actions switch was off or GitHub was down/)
  })

  it('judges the newest closed slot, so a past outage cannot excuse a cron that is still broken', () => {
    // The 2026-11-07 slot was silent because Actions was off; by 11-08 and 11-09 the repository was
    // busy again. Reading the oldest slot would keep pointing at the outage.
    const now = Date.parse('2026-11-10T12:00:00Z')
    const lastRun = new Date(Date.parse('2026-11-06T12:31:41Z')).toISOString()
    const verdict = judgeLiveness(
      [run({ databaseId: 91, conclusion: 'failure', createdAt: lastRun })],
      now,
      {
        repoRuns: [
          repoRun(Date.parse('2026-11-06T18:09:57Z')),
          repoRun(Date.parse('2026-11-08T11:00:00Z'), 'Fork CI health'),
          repoRun(Date.parse('2026-11-09T11:00:00Z'), 'Fork CI health'),
          repoRun(Date.parse('2026-11-10T11:00:00Z'), 'Fork CI health')
        ]
      }
    )
    expect(verdict.missedSlot).toBe('2026-11-09T04:53:00Z')
    expect(verdict.missedSlots).toBe(4)
    expect(verdict.summary).toMatch(/this workflow's own schedule or enablement/)
    expect(verdict.summary).toMatch(/4 slots due since the last scheduled run/)
  })

  it('says the history stops short rather than calling a truncated page silence', () => {
    // A full page of runs all newer than the slot proves nothing about the slot; reading that as
    // silence would manufacture the cause this diagnosis exists to find.
    const truncated = Array.from({ length: 100 }, (_, index) =>
      repoRun(NOW - index * 60_000, 'Fork base gates')
    )
    const verdict = judgeLiveness([silentRun()], NOW, { repoRuns: truncated })
    expect(verdict.summary).toMatch(/holds no run before 2026-10-25T04:53:00Z/)
    expect(verdict.summary).toMatch(/no evidence either way/)
    expect(verdict.summary).not.toMatch(/Actions switch was off/)
  })

  it('calls a short page that cannot reach the slot no evidence, not silence', () => {
    // Why: this workflow's own last run is always older than the slot, so a page with nothing before
    // it cannot have reached the slot however few runs it holds — the full-page guard missed that.
    const verdict = judgeLiveness([silentRun()], NOW, {
      repoRuns: [repoRun(slot + 20 * HOUR_MS, 'Fork CI health')]
    })
    expect(verdict.repoRunsInWindow).toBe(0)
    expect(verdict.summary).toMatch(/holds no run before 2026-10-25T04:53:00Z/)
    expect(verdict.summary).not.toMatch(/Actions switch was off/)
  })

  it('says the repository history was unreadable rather than guessing a cause', () => {
    const verdict = judgeLiveness([silentRun()], NOW, { repoReadError: 'gh: HTTP 403' })
    expect(verdict).toMatchObject({ ok: false, code: 1, staleSchedule: true })
    expect(verdict.repoReadError).toBe('gh: HTTP 403')
    expect(verdict.summary).toMatch(/could not be read \(gh: HTTP 403\)/)
    expect(verdict.summary).toMatch(/whether Actions itself was off is unknown/)
  })

  it('keeps the old wording when the repository history was not read at all', () => {
    const verdict = judgeLiveness([silentRun()], NOW)
    expect(verdict.staleSchedule).toBe(true)
    expect(verdict.repoRunsInWindow).toBeNull()
    expect(verdict.summary).toMatch(/the cron is not firing/)
    expect(verdict.summary).toMatch(/was not read/)
  })

  it('asks no repository-wide question when the schedule is healthy', () => {
    const verdict = judgeLiveness([run()], NOW, { repoRuns: [] })
    expect(verdict).toMatchObject({ ok: true, staleSchedule: false, repoRunsInWindow: null })
  })

  it('blames the schedule itself when there is no scheduled run to measure a slot from', () => {
    // A dispatch-only history has no schedule clock, so there is no window to look in and the old
    // sentence is still the right one — not "the history was not read".
    const verdict = judgeLiveness(
      [run({ event: 'workflow_dispatch', createdAt: hoursAgo(1) })],
      NOW,
      {
        repoRuns: [repoRun(NOW - HOUR_MS)]
      }
    )
    expect(verdict.missedSlot).toBeNull()
    expect(verdict.summary).toMatch(/the cron is not firing/)
    expect(verdict.summary).not.toMatch(/was not read/)
  })

  it('calls a backstop that never ran stale, so a consumer keying on the flag cannot miss it', () => {
    expect(judgeLiveness([], NOW)).toMatchObject({ ok: false, code: 1, staleSchedule: true })
  })

  it('classifies the slot window itself, without a verdict to hang it on', () => {
    const silent = diagnoseSlot(slot, [repoRun(lastBeforeSlot)], NOW)
    expect(silent).toMatchObject({ kind: 'silent', runsInWindow: 0 })
    expect(silent.silentHours).toBe(41.8)
    expect(diagnoseSlot(slot, [repoRun(slot + HOUR_MS, 'Mobile Checks')], NOW)).toMatchObject({
      kind: 'live',
      runsInWindow: 1,
      workflows: ['Mobile Checks']
    })
    // Why unknown: a missing slot and an unread history are different failures, and only one of them
    // is a statement about Actions.
    expect(diagnoseSlot(null, [], NOW)).toMatchObject({ kind: 'unknown', reason: 'no-slot' })
    expect(diagnoseSlot(slot, null, NOW)).toMatchObject({ kind: 'unknown', reason: 'not-read' })
  })

  it('counts a run exactly at the slot and one exactly at the window edge, and neither beyond', () => {
    const atEdge = Date.parse('2026-10-25T16:53:00Z')
    expect(diagnoseSlot(slot, [repoRun(slot)], NOW).runsInWindow).toBe(1)
    expect(diagnoseSlot(slot, [repoRun(atEdge)], NOW).runsInWindow).toBe(1)
    expect(diagnoseSlot(slot, [repoRun(atEdge + 1)], NOW).runsInWindow).toBe(0)
  })
})

describe('missedSchedule', () => {
  const at = (iso) => Date.parse(iso)
  const utc = (ms) => new Date(ms).toISOString().replace(/\.000Z$/, 'Z')

  it('counts every due slot, oldest first in the listing', () => {
    const owed = missedSchedule('2026-11-06T12:31:41Z', at('2026-11-09T05:00:00Z'))
    expect(owed.due).toBe(3)
    expect(owed.recent.map(utc)).toEqual([
      '2026-11-07T04:53:00Z',
      '2026-11-08T04:53:00Z',
      '2026-11-09T04:53:00Z'
    ])
  })

  it("takes the same day's slot when the last run landed before it", () => {
    const owed = missedSchedule('2026-11-06T02:00:00Z', at('2026-11-07T06:00:00Z'))
    expect(owed.due).toBe(2)
    expect(owed.recent.map(utc)).toEqual(['2026-11-06T04:53:00Z', '2026-11-07T04:53:00Z'])
  })

  it('owes nothing when no slot has come due yet, or when the timestamp is unreadable', () => {
    expect(missedSchedule('2026-11-06T12:31:41Z', at('2026-11-07T01:00:00Z'))).toEqual({
      slot: null,
      due: 0,
      recent: []
    })
    expect(missedSchedule('not a date', at('2026-11-08T04:30:00Z')).due).toBe(0)
  })

  it('judges the newest slot whose window has closed, never one that is still open', () => {
    // 11-09's window closes at 16:53, so at 05:00 the newest closed slot is 11-08's.
    expect(utc(missedSchedule('2026-11-06T12:31:41Z', at('2026-11-09T05:00:00Z')).slot)).toBe(
      '2026-11-08T04:53:00Z'
    )
    expect(utc(missedSchedule('2026-11-06T12:31:41Z', at('2026-11-09T17:00:00Z')).slot)).toBe(
      '2026-11-09T04:53:00Z'
    )
  })

  it('excludes a slot the last run landed on, and includes the one before it', () => {
    // The rule is `slot > from` on both sides, so a run exactly at 04:53 owes the next day's slot.
    expect(missedSchedule('2026-11-07T04:53:00Z', at('2026-11-08T05:00:00Z')).due).toBe(1)
    expect(missedSchedule('2026-11-07T04:53:00.001Z', at('2026-11-08T05:00:00Z')).due).toBe(1)
    expect(missedSchedule('2026-11-07T04:52:59.999Z', at('2026-11-08T05:00:00Z')).due).toBe(2)
  })

  it('treats a window closing exactly now as closed', () => {
    const owed = missedSchedule('2026-11-06T12:31:41Z', at('2026-11-08T16:53:00Z'))
    expect(utc(owed.slot)).toBe('2026-11-08T04:53:00Z')
  })

  it('keeps counting past the listing cap, so a month of silence is not reported as two weeks', () => {
    // Why: the first version capped the enumeration at 14 slots, which both froze the judged slot two
    // weeks in the past and understated the outage — the same bug it was written to fix.
    const owed = missedSchedule('2026-10-01T12:00:00Z', at('2026-11-08T05:00:00Z'))
    expect(owed.due).toBe(38)
    expect(owed.recent).toHaveLength(14)
    // 11-08's slot is due but its window is still open at 05:00, so 11-07's is the one judged.
    expect(utc(owed.recent.at(-1))).toBe('2026-11-08T04:53:00Z')
    expect(utc(owed.slot)).toBe('2026-11-07T04:53:00Z')
  })
})

describe('nightly liveness CLI', () => {
  it('exits 2 with a full JSON shape when gh cannot be read', () => {
    const result = spawnSync(process.execPath, ['local/check-nightly-liveness.mjs', '--json'], {
      cwd: new URL('../..', import.meta.url).pathname,
      // An empty PATH is how "gh is not installed" happens, and exit 2 must never read as a pass.
      env: { ...process.env, PATH: '' },
      encoding: 'utf8'
    })
    expect(result.status).toBe(2)
    const facts = JSON.parse(result.stdout)
    expect(facts).toMatchObject({ ok: false, code: 2 })
    expect(facts.summary).toMatch(/cannot read run history/)
    // Same keys as a verdict path, so a consumer can rely on the shape rather than the branch.
    expect(Object.keys(facts).sort()).toEqual(
      [
        'ageHours',
        'attempt',
        'code',
        'conclusion',
        'event',
        'failedJobs',
        'headSha',
        'jobReadError',
        'ok',
        'runId',
        'runsInLastDay',
        'scheduleAgeHours',
        'scheduleRunId',
        'status',
        'summary',
        'unreadRuns',
        'verdictAgeHours',
        'verdictRunId',
        'verdictlessRuns',
        'wedgeAgeHours',
        'staleSchedule',
        'missedSlot',
        'missedSlots',
        'repoRunsInWindow',
        'repoReadError'
      ].sort()
    )
  })
})
