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
const STALE_AFTER_H = 36
const WEDGED_AFTER_H = 4
// How many verdict-less completed runs to read jobs for. Bounded because each one is a `gh` call.
const JOB_LOOKUPS = 5

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
  jobReadError: null
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

async function fetchJobs(runId) {
  const { stdout } = await run(
    'gh',
    ['run', 'view', String(runId), '--repo', REPO, '--json', 'jobs'],
    { maxBuffer: 8 * 1024 * 1024 }
  )
  return JSON.parse(stdout).jobs ?? []
}

const ageHours = (iso, now) => (now - Date.parse(iso)) / HOUR

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
export function judgeLiveness(runs, now = Date.now(), { jobs = {}, jobReadError = null } = {}) {
  if (!Array.isArray(runs) || runs.length === 0) {
    return {
      ...EMPTY_FACTS,
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
    jobReadError
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
    return {
      ...facts,
      ok: false,
      code: 1,
      summary:
        `${ageText}, past the ${STALE_AFTER_H}h threshold for a ` +
        `${CRON_UTC_HOUR}:${String(CRON_UTC_MINUTE).padStart(2, '0')} UTC daily schedule — the cron ` +
        `is not firing, or the workflow is disabled.${inFlightNote}${verdictlessNote}${jobErrorNote}`
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

  const verdict = judgeLiveness(runs, Date.now(), { jobs, jobReadError })
  if (json) {
    console.log(JSON.stringify(verdict, null, 2))
  } else {
    const line = verdict.ok ? 'nightly liveness: PASS' : 'nightly liveness: ATTENTION'
    console.error(`${line} — ${verdict.summary}`)
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
