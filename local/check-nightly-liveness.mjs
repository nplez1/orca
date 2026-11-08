#!/usr/bin/env node
/**
 * Report whether the nightly unit backstop is actually running.
 *
 * The backstop is `.github/workflows/fork-main-tests.yml`. Its last passing run was 2026-10-08. The
 * 2026-10-26 schedule then hit two problems at once: its `relay_integration` job queued on a runner
 * label this fork does not provision, and four of its five test shards failed. The run sat for ~17.5h
 * and was eventually cancelled, which set the run-level conclusion to `cancelled` and hid the red
 * shards behind it — eighteen days with no passing night and nothing that said so. Hence this check,
 * and hence the rule below: a run-level conclusion that is not a verdict must not outrank the jobs'.
 *
 * Exit codes are the contract: 0 healthy, 1 stale or wedged or red, 2 cannot tell. "Cannot tell" is
 * not a pass — it is reported separately so a missing `gh` never reads as a green nightly.
 *
 * A stale schedule has three causes, and the workflow-scoped run list can only see the first: the cron
 * is broken, this workflow is disabled, or the repository-level Actions switch is off. The third is not
 * hypothetical — on 2026-11-06 GitHub turned Actions off for the whole repository to stop inherited
 * upstream crons, the 2026-11-07 slot went unanswered, and this check could only guess between the
 * first two while the actual cause sat in a repository setting no workflow token may read. So a stale
 * verdict also reads repository-wide history: silence across the window the slot should have fired in
 * names the switch, and a scheduled run of some other workflow in it puts the fault back on this one.
 */
import { execFile } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

const WORKFLOW = 'fork-main-tests.yml'
const REPO = 'nplez1/orca'
// The schedule only ever runs on the default branch, and a dispatch on a feature branch must not be
// able to answer for the nightly.
const BRANCH = 'nplez1/main'
const CRON_UTC_HOUR = 4
const CRON_UTC_MINUTE = 53

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const STALE_AFTER_H = 36
const WEDGED_AFTER_H = 4
// How many verdict-less completed runs to read jobs for. Bounded because each one is a `gh` call.
const JOB_LOOKUPS = 5
/**
 * How late a scheduled run may still appear before its slot counts as missed. GitHub delays cron fires
 * on a busy public repository by hours — every nightly here has landed between 10:37 and 12:54 UTC
 * against a 04:53 schedule — so a slot is judged by the runs that arrive inside this window, not by
 * the slot's own minute.
 */
const SCHEDULE_DELAY_H = 12
// How many due slots the report lists. The count is arithmetic and uncapped; only the listing is bounded.
const MAX_LISTED_SLOTS = 14
// Repo-wide history depth: the only evidence that separates "this cron is broken" from "Actions was
// off for the whole repository".
const REPO_RUN_LIMIT = 100

// Every path emits the same keys, with null where there is nothing to report, so a consumer of --json
// can rely on the shape rather than on which branch produced the verdict.
const EMPTY_FACTS = {
  runId: null,
  status: null,
  conclusion: null,
  ageHours: null,
  headSha: null,
  event: null,
  attempt: null,
  wedgeAgeHours: null,
  runsInLastDay: 0,
  scheduleRunId: null,
  scheduleAgeHours: null,
  verdictRunId: null,
  verdictAgeHours: null,
  failedJobs: [],
  verdictlessRuns: 0,
  unreadRuns: 0,
  jobReadError: null,
  staleSchedule: false,
  missedSlot: null,
  missedSlots: 0,
  repoRunsInWindow: null,
  repoReadError: null
}

const run = promisify(execFile)

const FIELDS = [
  'attempt',
  'conclusion',
  'createdAt',
  'databaseId',
  'event',
  'headSha',
  'startedAt',
  'status',
  'url'
].join(',')

async function fetchRuns(limit = 10) {
  const { stdout } = await run(
    'gh',
    [
      'run',
      'list',
      '--workflow',
      WORKFLOW,
      '--repo',
      REPO,
      '--branch',
      BRANCH,
      '--limit',
      String(limit),
      '--json',
      FIELDS
    ],
    { maxBuffer: 8 * 1024 * 1024 }
  )
  // `gh` reports an unfinished run's conclusion as "", not null.
  const runs = JSON.parse(stdout)
  return runs.map((r) => ({ ...r, conclusion: r.conclusion || null }))
}

const REPO_FIELDS = ['createdAt', 'databaseId', 'event', 'status', 'workflowName'].join(',')

/**
 * Every workflow's runs, newest first. Not filtered by workflow or branch on purpose: the question is
 * what ran anywhere in this repository, and the `event` field separates a live scheduler from a live
 * repository.
 */
async function fetchRepoRuns() {
  const { stdout } = await run(
    'gh',
    ['run', 'list', '--repo', REPO, '--limit', String(REPO_RUN_LIMIT), '--json', REPO_FIELDS],
    { maxBuffer: 8 * 1024 * 1024 }
  )
  return JSON.parse(stdout)
}

async function fetchJobs(runId) {
  const { stdout } = await run(
    'gh',
    ['run', 'view', String(runId), '--repo', REPO, '--json', 'jobs'],
    { maxBuffer: 8 * 1024 * 1024 }
  )
  return JSON.parse(stdout).jobs ?? []
}

const ageHours = (iso, now) => (now - Date.parse(iso)) / HOUR
const iso = (ms) => (ms === null ? null : new Date(ms).toISOString().replace(/\.000Z$/, 'Z'))

/** The newest cron slot at or before `at`, as an epoch millisecond. */
function newestSlotAtOrBefore(at) {
  const d = new Date(at)
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  const offset = (CRON_UTC_HOUR * 60 + CRON_UTC_MINUTE) * 60 * 1000
  const today = midnight + offset
  return today <= at ? today : today - DAY
}

/**
 * The cron slots this schedule owes.
 *
 * - `slot` — the newest slot whose window has closed, which is the one worth judging. The oldest would
 *   blame a past outage for a cron that is still broken: after the 2026-11-07 silence, the slots since
 *   are what say whether it is firing *now*.
 * - `due` — how many slots have come due, counted arithmetically and never capped, because an outage
 *   that lasted a month must not be reported as two weeks.
 * - `recent` — the last `MAX_LISTED_SLOTS` due slots, oldest first, for display.
 *
 * A slot whose window is still open is counted as due but never judged: it may still produce a run.
 */
export function missedSchedule(lastScheduledIso, now = Date.now()) {
  const from = Date.parse(lastScheduledIso)
  if (!Number.isFinite(from)) {
    return { slot: null, due: 0, recent: [] }
  }
  const newestDue = newestSlotAtOrBefore(now)
  const firstDue = newestSlotAtOrBefore(from) + DAY
  if (newestDue < firstDue) {
    return { slot: null, due: 0, recent: [] }
  }
  const due = (newestDue - firstDue) / DAY + 1
  const closed = newestSlotAtOrBefore(now - SCHEDULE_DELAY_H * HOUR)
  const recent = []
  for (
    let slot = Math.max(firstDue, newestDue - (MAX_LISTED_SLOTS - 1) * DAY);
    slot <= newestDue;
    slot += DAY
  ) {
    recent.push(slot)
  }
  return { slot: closed < firstDue ? null : closed, due, recent }
}

/**
 * Why a slot went unanswered, read from repository-wide history rather than this workflow's own.
 *
 * A repository that keeps four workflows on a daily clock cannot go quiet for half a day by itself, so
 * silence across the window the slot should have fired in means the repository-level Actions switch
 * was off or GitHub was down — neither of which this workflow can fix, and neither of which the
 * workflow-scoped run list can see. Runs without a `schedule` event are a third answer: the repository
 * is working and the scheduler is not firing crons at all, which no enablement of this workflow's
 * explains. Only a scheduled run of some workflow puts the fault back on this workflow.
 */
export function diagnoseSlot(slot, repoRuns, now = Date.now()) {
  const empty = {
    kind: 'unknown',
    reason: 'no-slot',
    runsInWindow: null,
    workflows: [],
    silentFrom: null,
    silentHours: null
  }
  if (slot === null) {
    return empty
  }
  if (!Array.isArray(repoRuns)) {
    return { ...empty, reason: 'not-read' }
  }
  const windowEnd = slot + SCHEDULE_DELAY_H * HOUR
  const created = repoRuns.map((record) => Date.parse(record.createdAt)).filter(Number.isFinite)
  const inWindow = repoRuns.filter((record) => {
    const at = Date.parse(record.createdAt)
    return at >= slot && at <= windowEnd
  })
  const before = created.filter((at) => at < slot).sort((a, b) => b - a)[0] ?? null
  const after = created.filter((at) => at > windowEnd).sort((a, b) => a - b)[0] ?? null
  const facts = {
    runsInWindow: inWindow.length,
    workflows: [...new Set(inWindow.map((record) => record.workflowName))].slice(0, 3),
    silentFrom: iso(before),
    silentHours: before === null ? null : Math.round(((after ?? now) - before) / HOUR / 0.1) / 10
  }
  if (inWindow.length > 0) {
    const scheduled = inWindow.filter((record) => record.event === 'schedule').length
    return scheduled > 0
      ? { ...facts, kind: 'live', reason: 'scheduled' }
      : { ...facts, kind: 'cron-less', reason: 'no-scheduled-run' }
  }
  // Why: silence needs a run *before* the slot to be a silence at all. This workflow's own last run is
  // always older than the slot, so a page with nothing before it cannot reach the slot — and reading
  // that as silence is how a short list would manufacture the exact false cause this exists to avoid.
  if (before === null) {
    return { ...facts, kind: 'unknown', reason: 'short-history' }
  }
  return { ...facts, kind: 'silent', reason: 'silence' }
}

/** The one sentence that says which cause a stale schedule has. */
function stalenessCause({ slot, diagnosis, repoReadError, missedCount }) {
  if (slot === null) {
    // No scheduled run to measure a slot from — the schedule itself is the answer.
    return 'the cron is not firing, or the workflow is disabled.'
  }
  const slotText = `the ${iso(slot)} slot`
  const slotsText = missedCount > 1 ? ` (${missedCount} slots due since then)` : ''
  if (diagnosis.kind === 'unknown') {
    const why =
      repoReadError !== null
        ? `the repository-wide run history could not be read (${repoReadError})`
        : diagnosis.reason === 'short-history'
          ? `the repository-wide history holds no run before ${iso(slot)}, so there is no evidence either way`
          : 'the repository-wide run history was not read'
    return (
      'the cron is not firing, or the workflow is disabled — ' +
      `and ${why}, so whether Actions itself was off is unknown.`
    )
  }
  if (diagnosis.kind === 'silent') {
    const silence =
      diagnosis.silentFrom === null
        ? `no workflow in ${REPO} ran in the ${SCHEDULE_DELAY_H}h after it either`
        : `no workflow in ${REPO} ran in the ${SCHEDULE_DELAY_H}h after it either ` +
          `(${diagnosis.silentHours}h of silence from ${diagnosis.silentFrom})`
    return (
      `${slotText}${slotsText} produced no run, and ${silence} — so the repository-level Actions ` +
      `switch was off or GitHub was down, which is not this cron. Check ` +
      `https://github.com/${REPO}/settings/actions, then re-run this once Actions is back.`
    )
  }
  const names = diagnosis.workflows.join(', ')
  if (diagnosis.kind === 'cron-less') {
    return (
      `${slotText}${slotsText} produced no run, and although ${diagnosis.runsInWindow} run(s) did ` +
      `start inside its ${SCHEDULE_DELAY_H}h window (${names}), none of them was scheduled — so ` +
      `no cron in the repository fired in that window either, which this workflow's enablement does ` +
      `not explain.`
    )
  }
  return (
    `${slotText}${slotsText} produced no run, but ${diagnosis.runsInWindow} run(s) started inside ` +
    `its ${SCHEDULE_DELAY_H}h window and at least one was scheduled (${names}), so Actions and its ` +
    `scheduler are both live and this workflow's own schedule or enablement is the problem.`
  )
}

/**
 * Conclusions that carry no verdict about the code by themselves. A cancelled run says a human or a
 * timeout stopped it, so the run-level word alone is not a verdict either way. But a cancelled run is
 * no evidence of green — run 40308443374 was cancelled with four of five shards failed — so the jobs
 * decide whenever the run-level conclusion does not.
 */
const VERDICTLESS = new Set(['cancelled', 'skipped', 'neutral', null, undefined, ''])

const RED_JOBS = new Set(['failure', 'timed_out', 'startup_failure'])

const failedJobNames = (jobs) =>
  (jobs ?? []).filter((job) => RED_JOBS.has(job.conclusion)).map((job) => job.name)

/**
 * The verdict a run actually produced: its own conclusion when that is one, otherwise its jobs'.
 * A cancelled run with failed shards is red — that run really did fail four of five shards.
 * A cancelled run whose jobs all passed proved nothing about the suite and stays verdict-less.
 */
export function verdictOf(runRecord, jobs) {
  if (runRecord.status !== 'completed') {
    return { conclusion: null, failedJobs: [] }
  }
  if (!VERDICTLESS.has(runRecord.conclusion)) {
    return { conclusion: runRecord.conclusion, failedJobs: failedJobNames(jobs) }
  }
  const failedJobs = failedJobNames(jobs)
  return { conclusion: failedJobs.length > 0 ? 'failure' : null, failedJobs }
}

/**
 * Completed runs whose own conclusion is not a verdict and which are newer than the newest run that
 * has one, newest first, bounded by `limit`. The boundary matters: a verdict-less run older than a
 * resolved verdict cannot change the answer, one newer than it can flip green to red.
 */
export function runsNeedingJobs(runs, limit = JOB_LOOKUPS) {
  const ordered = [...runs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  const newestOwnVerdict = ordered.find(
    (r) => r.status === 'completed' && !VERDICTLESS.has(r.conclusion)
  )
  const boundary = newestOwnVerdict ? Date.parse(newestOwnVerdict.createdAt) : -Infinity
  return ordered
    .filter(
      (r) =>
        r.status === 'completed' &&
        VERDICTLESS.has(r.conclusion) &&
        Date.parse(r.createdAt) >= boundary
    )
    .slice(0, limit)
    .map((r) => r.databaseId)
}

/** Judge liveness from already-fetched runs, so the decision is testable without a network. */
export function judgeLiveness(
  runs,
  now = Date.now(),
  { jobs = {}, jobReadError = null, repoRuns = null, repoReadError = null } = {}
) {
  if (!Array.isArray(runs) || runs.length === 0) {
    return {
      ...EMPTY_FACTS,
      // A backstop that has never run is the worst case, so it is stale by definition — a consumer
      // keying on this field must not miss it.
      staleSchedule: true,
      ok: false,
      code: 1,
      summary: `no run of ${WORKFLOW} has ever been recorded — the backstop is not wired up`
    }
  }

  // Two clocks: the schedule's (a scheduled run proves the cron fires) and the backstop's (only a
  // completed run with a verdict proves the suite still passes). A dispatch proves neither: it is a
  // human asking, and counting it would let a daily manual run hide a dead cron.
  const ordered = [...runs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  const newest = ordered[0]
  const scheduled = ordered.filter((r) => r.event === 'schedule')
  const newestScheduled = scheduled[0] ?? null
  const resolved = ordered
    .filter((r) => r.status === 'completed')
    .map((r) => ({ run: r, ...verdictOf(r, jobs[r.databaseId]) }))
  const verdictRun = resolved.find((v) => v.conclusion !== null) ?? null

  const age = ageHours(newest.createdAt, now)
  const scheduleAge = newestScheduled ? ageHours(newestScheduled.createdAt, now) : null
  const wedgeAge = ageHours(newest.startedAt ?? newest.createdAt, now)
  const verdictAge = verdictRun ? ageHours(verdictRun.run.createdAt, now) : null
  const inFlight = newest.status !== 'completed'
  const lastDay = scheduled.filter((r) => ageHours(r.createdAt, now) <= 24).length
  const verdictless = resolved.filter((v) => v.conclusion === null)
  // A verdict-less run newer than the verdict can flip green to red, so it may not be left unread.
  // `main()` asks for exactly these; seeing one here without jobs means the read was not attempted or
  // failed, and the honest answer to "is the nightly green" is then that it cannot be known.
  const unread = verdictless.filter(
    (v) =>
      !Object.hasOwn(jobs, v.run.databaseId) &&
      (verdictRun === null || Date.parse(v.run.createdAt) >= Date.parse(verdictRun.run.createdAt))
  )

  const facts = {
    runId: newest.databaseId,
    status: newest.status,
    conclusion: newest.conclusion || null,
    ageHours: Math.round(age * 10) / 10,
    headSha: newest.headSha?.slice(0, 10) ?? null,
    event: newest.event,
    attempt: newest.attempt ?? null,
    wedgeAgeHours: Math.round(wedgeAge * 10) / 10,
    runsInLastDay: lastDay,
    scheduleRunId: newestScheduled?.databaseId ?? null,
    scheduleAgeHours: scheduleAge === null ? null : Math.round(scheduleAge * 10) / 10,
    verdictRunId: verdictRun?.run.databaseId ?? null,
    verdictAgeHours: verdictAge === null ? null : Math.round(verdictAge * 10) / 10,
    failedJobs: verdictRun?.failedJobs ?? [],
    verdictlessRuns: verdictless.length,
    unreadRuns: unread.length,
    jobReadError,
    staleSchedule: false,
    missedSlot: null,
    missedSlots: 0,
    repoRunsInWindow: null,
    repoReadError
  }

  const verdictlessNote =
    verdictless.length > 0
      ? ` (${verdictless.length} run(s) carried no verdict: ${verdictless
          .map((v) => v.run.conclusion ?? v.run.status)
          .join(', ')})`
      : ''
  const hiddenRedNote = verdictRun?.failedJobs.length
    ? ` — run ${verdictRun.run.databaseId} is ${verdictRun.run.conclusion} at the run level but ` +
      `${verdictRun.failedJobs.length} of its jobs failed (${verdictRun.failedJobs.join(', ')})`
    : ''
  const jobErrorText = typeof jobReadError === 'string' ? jobReadError : 'unknown'
  const jobErrorNote = jobReadError
    ? ` — job detail unavailable (${jobErrorText}), so a cancelled run's own shard failures may be hidden`
    : ''
  const attempt = facts.attempt ?? 1
  const inFlightNote = inFlight
    ? `; run ${newest.databaseId} is ${newest.status} (${facts.ageHours}h) and has no verdict yet${attempt > 1 ? `, attempt ${attempt}` : ''}`
    : ''

  if (scheduleAge === null || scheduleAge > STALE_AFTER_H) {
    const ageText =
      scheduleAge === null
        ? 'no scheduled run has ever been recorded'
        : `the newest scheduled run is ${facts.scheduleAgeHours}h old (${newestScheduled.conclusion ?? newestScheduled.status})`
    const owed = newestScheduled
      ? missedSchedule(newestScheduled.createdAt, now)
      : { slot: null, due: 0, recent: [] }
    const diagnosis = diagnoseSlot(owed.slot, repoRuns, now)
    return {
      ...facts,
      staleSchedule: true,
      // The slot being judged, which is the newest one whose window has closed — not the first missed.
      missedSlot: iso(owed.slot),
      missedSlots: owed.due,
      repoRunsInWindow: diagnosis.runsInWindow,
      ok: false,
      code: 1,
      summary:
        `${ageText}, past the ${STALE_AFTER_H}h threshold for a ` +
        `${CRON_UTC_HOUR}:${String(CRON_UTC_MINUTE).padStart(2, '0')} UTC daily schedule — ` +
        `${stalenessCause({ slot: owed.slot, diagnosis, repoReadError, missedCount: owed.due })}` +
        `${inFlightNote}${verdictlessNote}${jobErrorNote}`
    }
  }
  if (inFlight && wedgeAge > WEDGED_AFTER_H) {
    return {
      ...facts,
      ok: false,
      code: 1,
      summary:
        `run ${newest.databaseId} has been ${newest.status} for ${facts.wedgeAgeHours}h of its ` +
        `${facts.ageHours}h life${facts.attempt > 1 ? ` (attempt ${facts.attempt})` : ''} — that is a ` +
        'wedged run, not a slow one. Check which job is stuck (a runner label this fork does not ' +
        'provision is the known cause) and cancel it: the next scheduled run supersedes it, so ' +
        'leaving it costs a night of coverage, not the run.'
    }
  }
  // Why an in-flight run does not answer for the backstop: it has produced no verdict yet, so
  // returning a pass here would report PASS for up to WEDGED_AFTER_H after yesterday went red, and
  // would hide a verdict that is already stale. The verdict decides; the in-flight run is a note.
  if (!verdictRun) {
    return {
      ...facts,
      ok: false,
      code: 1,
      summary:
        'no completed run in the fetched history has produced a verdict — the schedule is ' +
        `firing (newest scheduled run ${facts.scheduleAgeHours}h ago) but nothing has actually run ` +
        `the suite${inFlightNote}${verdictlessNote}${jobErrorNote}`
    }
  }
  if (verdictAge > STALE_AFTER_H) {
    return {
      ...facts,
      ok: false,
      code: 1,
      summary:
        `the newest verdict is ${facts.verdictAgeHours}h old (${verdictRun.run.conclusion}) even ` +
        `though a run exists ${facts.ageHours}h ago${hiddenRedNote}${inFlightNote}${verdictlessNote}` +
        `${jobErrorNote} — read that as the backstop being down, not as green`
    }
  }
  const green = verdictRun.conclusion === 'success'
  if (green && unread.length > 0) {
    return {
      ...facts,
      ok: false,
      code: 2,
      summary:
        `cannot tell: ${unread.length} completed run(s) newer than the last passing one were not ` +
        `inspected (${unread.map((v) => v.run.databaseId).join(', ')}), and a cancelled or skipped ` +
        'run can still have failed shards. Not a pass.'
    }
  }
  return {
    ...facts,
    ok: green,
    code: green ? 0 : 1,
    summary:
      `nightly ${green ? 'green' : `red (${verdictRun.conclusion})`} at ${facts.verdictAgeHours}h ` +
      `old, ${lastDay} scheduled run(s) in the last 24h${hiddenRedNote}${inFlightNote}` +
      `${verdictlessNote}${jobErrorNote}`
  }
}

const firstLine = (error) => (error.stderr ?? error.message ?? String(error)).split('\n')[0].trim()

async function main() {
  const json = process.argv.includes('--json')
  let runs
  try {
    runs = await fetchRuns()
  } catch (error) {
    const message = error.code === 'ENOENT' ? 'gh is not installed' : firstLine(error)
    if (json) {
      console.log(
        JSON.stringify(
          {
            ...EMPTY_FACTS,
            ok: false,
            code: 2,
            summary: `cannot read run history: ${message}`
          },
          null,
          2
        )
      )
    } else {
      console.error(`nightly liveness: cannot tell — ${message}`)
    }
    process.exit(2)
  }

  const jobs = {}
  let jobReadError = null
  for (const runId of runsNeedingJobs(runs)) {
    try {
      jobs[runId] = await fetchJobs(runId)
    } catch (error) {
      jobReadError = jobReadError ?? firstLine(error)
    }
  }

  const now = Date.now()
  let verdict = judgeLiveness(runs, now, { jobs, jobReadError })
  if (verdict.staleSchedule && verdict.missedSlot !== null) {
    // Why only when a slot is due: one more `gh` call on the daily path, for a question that only
    // exists on a night the schedule did not produce.
    let repoRuns = null
    let repoReadError = null
    try {
      repoRuns = await fetchRepoRuns()
    } catch (error) {
      repoReadError = firstLine(error)
    }
    verdict = judgeLiveness(runs, now, { jobs, jobReadError, repoRuns, repoReadError })
  }
  if (json) {
    console.log(JSON.stringify(verdict, null, 2))
  } else {
    const line = verdict.ok ? 'nightly liveness: PASS' : 'nightly liveness: ATTENTION'
    console.error(`${line} — ${verdict.summary}`)
    // Red shards carry the nightly's Vitest reports; they also answer whether the Mac-allowlisted
    // known-red entries actually pass on Linux, which is the check the triage rule points at.
    if (verdict.failedJobs.length > 0) {
      console.error(
        'a red shard also leaves its report to triage with: node local/check-nightly-linux-parity.mjs <downloaded unit-shard artifacts dir>'
      )
    }
  }
  process.exit(verdict.code)
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  await main()
}
