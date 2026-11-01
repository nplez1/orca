#!/usr/bin/env node
/**
 * Report runs and jobs that are waiting for a runner instead of running on one.
 *
 * This is the failure mode `timeout-minutes` cannot bound: a timeout starts counting when a runner
 * picks the job up, so a job waiting on a label this fork does not provision waits until GitHub's 24 h
 * queue limit, not until its own timeout. It has happened twice — `relay_integration` queued ~17.5 h on
 * `blacksmith-4vcpu-ubuntu-2404` on 2026-10-26, and "Unit transform cache producer" wedged for 12 h on
 * 2026-10-28. Both runs still reported `in_progress`, because their other jobs were fine, so the
 * run-level status said nothing; the cancel that ended the first one then hid four red shards behind a
 * `cancelled` conclusion.
 *
 * Hence the two things a run-level status cannot show: a run that is still `queued`, and a *job* that
 * is `queued` inside a run that reads `in_progress`.
 *
 *   node local/check-queued-runs.mjs            report
 *   node local/check-queued-runs.mjs --json     the same facts as JSON
 *
 * Exit codes are the contract: 0 nothing waiting, 1 something waiting past the limit, 2 cannot tell.
 * "Cannot tell" is not a pass — a missing `gh` must never read as a healthy queue.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO = 'nplez1/orca'
const HOUR = 60 * 60 * 1000

/** A job or run in any of these states has not been handed a runner yet. */
export const WAITING_STATUSES = new Set(['queued', 'requested', 'waiting', 'pending'])

/**
 * Why the wait happened, because the remedy differs and two of them are not a runner problem:
 * `waiting` is an environment protection rule holding the job for approval, and `pending` is another
 * run holding the concurrency group.
 */
const WAIT_REASON = {
  queued: 'runner',
  requested: 'runner',
  waiting: 'environment',
  pending: 'concurrency'
}

/** One hour: long enough that a cold runner start is not a finding, short enough to cancel by hand. */
export const WAIT_LIMIT_H = 1

/** Each job lookup is a `gh` call, so the in-flight set is bounded rather than unbounded. */
export const RUN_LOOKUPS = 10

const firstLine = (error) =>
  String(error.stderr ?? error.message ?? error)
    .split('\n')[0]
    .trim()

/** Hours since an ISO timestamp, or `null` when the timestamp is missing rather than zero. */
export function waitedHours(since, now) {
  const at = Date.parse(since ?? '')
  return Number.isFinite(at) ? (now - at) / HOUR : null
}

/**
 * Judge the queue from runs and jobs already fetched, so the decision is testable without a network.
 *
 * `jobsByRun` maps a run id to its jobs. A run that is itself waiting is reported once at run level and
 * its jobs are skipped: they are queued because the run is, and two rows for one cause read as two
 * problems.
 */
export function judgeQueue(
  { runs = [], jobsByRun = {} },
  { now = Date.now(), limitH = WAIT_LIMIT_H } = {}
) {
  const waited = []
  let inFlight = 0
  for (const run of runs) {
    const status = String(run.status ?? '')
    if (status === 'completed') {
      continue
    }
    inFlight++
    // `run_started_at` is the current attempt's start: a re-run of a week-old run is not a week-old
    // wait. It is null while nothing has started, and then the run's creation is the queue start.
    const queuedSince = run.run_started_at ?? run.created_at
    const runAge = waitedHours(queuedSince, now)
    if (WAITING_STATUSES.has(status) && runAge !== null && runAge > limitH) {
      // Why the jobs are read here: a run waiting with jobs on a label is a provisioning problem, and
      // one waiting with no jobs is a GitHub-side record that no cancel reaches. Only the first is
      // fixed by cancelling, so the two must not share a remedy line. Only a runner-queued run can be
      // the second kind — `pending` and `waiting` legitimately have jobs.
      const jobs = jobsByRun[run.id]
      const emptyJobs = Object.hasOwn(jobsByRun, run.id) && (jobs ?? []).length === 0
      waited.push({
        where: emptyJobs && WAIT_REASON[status] === 'runner' ? 'ghost' : 'run',
        status,
        runId: run.id,
        runName: run.name,
        jobName: null,
        labels: [],
        ageHours: runAge,
        url: run.html_url
      })
      continue
    }
    for (const job of jobsByRun[run.id] ?? []) {
      if (job.started_at || !WAITING_STATUSES.has(String(job.status ?? ''))) {
        continue
      }
      const jobAge = waitedHours(job.created_at ?? queuedSince, now)
      if (jobAge === null || jobAge <= limitH) {
        continue
      }
      waited.push({
        where: 'job',
        status: String(job.status ?? ''),
        runId: run.id,
        runName: run.name,
        jobName: job.name,
        labels: Array.isArray(job.labels) ? job.labels : [],
        ageHours: jobAge,
        url: run.html_url
      })
    }
  }
  const oldestHours = waited.reduce((worst, entry) => Math.max(worst, entry.ageHours), null)
  return { waited, inFlight, oldestHours, limitH, lookedAt: Object.keys(jobsByRun).length }
}

const hours = (value) => `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10}h`

export function describeVerdict(verdict) {
  const { waited, inFlight, limitH, oldestHours } = verdict
  const lookedAt = verdict.lookedAt ?? 0
  if (waited.length === 0) {
    return (
      `queued runs: PASS — nothing waiting past ${limitH}h across ${inFlight} in-flight run(s), ` +
      `jobs read for ${lookedAt}`
    )
  }
  const lines = [
    `queued runs: ATTENTION — ${waited.length} waiting past ${limitH}h (oldest ${hours(oldestHours)})`
  ]
  for (const entry of waited) {
    const labels = entry.labels.length > 0 ? ` [${entry.labels.join(',')}]` : ''
    const what =
      entry.where === 'job' ? `${entry.runName} / ${entry.jobName}${labels}` : entry.runName
    const tag = entry.where === 'ghost' ? 'NO JOBS' : 'QUEUED '
    lines.push(`  ${tag} ${hours(entry.ageHours).padStart(5)}  ${what} — ${entry.url}`)
  }
  if (waited.some((entry) => entry.where === 'ghost')) {
    lines.push(
      '  NO JOBS: a run queued with no jobs at all is a record GitHub will not cancel or force-cancel; ' +
        'delete it in the Actions UI. Its id is in the line above.'
    )
  }
  const reasons = new Set(
    waited.filter((entry) => entry.where !== 'ghost').map((entry) => WAIT_REASON[entry.status])
  )
  if (reasons.has('runner')) {
    lines.push(
      '  RUNNER: a label nothing provisions never picks a job up — cancel the run or provision the ' +
        'runner; LOCAL-PATCHES.md § local(ci) records the cases'
    )
  }
  if (reasons.has('environment')) {
    lines.push(
      '  ENVIRONMENT: `waiting` means a protection rule has not approved the job, so no runner is ' +
        'wanted and no timeout applies — approve it or cancel the run.'
    )
  }
  if (reasons.has('concurrency')) {
    lines.push(
      '  CONCURRENCY: `pending` means another run is holding the group — cancel that run to release it.'
    )
  }
  lines.push(`  jobs read for ${lookedAt} of ${inFlight} in-flight run(s)`)
  return lines.join('\n')
}

function gh(args) {
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }))
}

/**
 * Recent runs, the queued set and the in-progress set, deduped: a busy day can push an old waiting run
 * past the first page, and a job queued inside a long `in_progress` run is the shape of both incidents.
 */
function fetchRuns() {
  const pages = [
    gh(['api', `/repos/${REPO}/actions/runs?per_page=100`]).workflow_runs ?? [],
    gh(['api', `/repos/${REPO}/actions/runs?status=queued&per_page=100`]).workflow_runs ?? [],
    gh(['api', `/repos/${REPO}/actions/runs?status=in_progress&per_page=100`]).workflow_runs ?? []
  ]
  const byId = new Map()
  for (const run of pages.flat()) {
    byId.set(run.id, run)
  }
  return [...byId.values()]
}

/**
 * Read jobs for the oldest in-flight runs already past the limit. Oldest-first is the point: the API's
 * newest-first order would spend every lookup on runs that cannot have waited long enough, and would
 * cut the 17 h-old run the check exists for.
 */
function fetchJobsByRun(runs, now = Date.now()) {
  const candidates = runs
    .filter((run) => run.status !== 'completed')
    .filter((run) => {
      const age = waitedHours(run.run_started_at ?? run.created_at, now)
      return age !== null && age > WAIT_LIMIT_H
    })
    .sort(
      (left, right) =>
        Date.parse(left.run_started_at ?? left.created_at) -
        Date.parse(right.run_started_at ?? right.created_at)
    )
    .slice(0, RUN_LOOKUPS)
  const jobsByRun = {}
  for (const run of candidates) {
    jobsByRun[run.id] =
      gh(['api', `/repos/${REPO}/actions/runs/${run.id}/jobs?per_page=100`]).jobs ?? []
  }
  return jobsByRun
}

function main() {
  const json = process.argv.includes('--json')
  let verdict
  try {
    const runs = fetchRuns()
    verdict = judgeQueue({ runs, jobsByRun: fetchJobsByRun(runs) })
  } catch (error) {
    console.error(`queued runs: cannot tell — ${firstLine(error)}`)
    process.exit(2)
  }
  console.log(json ? JSON.stringify(verdict, null, 2) : describeVerdict(verdict))
  process.exit(verdict.waited.length > 0 ? 1 : 0)
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main()
}
