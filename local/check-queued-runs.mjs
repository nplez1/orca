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
 * is waiting inside a run that reads `in_progress`.
 *
 *   node local/check-queued-runs.mjs            report
 *   node local/check-queued-runs.mjs --json     the same facts as JSON
 *
 * Exit codes are the contract: 0 nothing waiting, 1 something waiting past the limit, 2 cannot tell.
 * "Cannot tell" is not a pass — a missing `gh` must never read as a healthy queue.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO = 'nplez1/orca'
const HOUR = 60 * 60 * 1000
const ROOT = resolve(import.meta.dirname, '..')

/**
 * A run that is waiting with no jobs at all is a GitHub-side record: no cancel reaches it, so it cannot
 * be cleared by anything except a delete in the UI. Left as a plain finding it holds this check red
 * forever, and `ci-health-report` *updates* one issue in place — an edit nobody is notified about — so a
 * new red from any check would land silently behind it. Listed here, it is reported as acknowledged and
 * does not redden the check; anything not listed still does.
 */
export const KNOWN_GHOSTS = 'local/queued-known-ghosts.json'

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
  String(error.stderr ?? error.message ?? error ?? '')
    .split('\n')[0]
    .trim()

/** Hours since an ISO timestamp, or `null` when the timestamp is missing rather than zero. */
export function waitedHours(since, now) {
  const at = Date.parse(since ?? '')
  return Number.isFinite(at) ? (now - at) / HOUR : null
}

/**
 * The run ids this check has been told to acknowledge, or `{ error }` when the file cannot be read.
 * A missing file is not an error — it means nothing has been acknowledged yet.
 */
export function readKnownGhosts(file = join(ROOT, KNOWN_GHOSTS)) {
  if (!existsSync(file)) {
    return new Set()
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const entries = Array.isArray(parsed?.ghosts) ? parsed.ghosts : []
    return new Set(entries.map((entry) => entry.runId).filter((id) => Number.isInteger(id)))
  } catch (error) {
    return { error: firstLine(error) }
  }
}

/**
 * Judge the queue from runs and jobs already fetched, so the decision is testable without a network.
 *
 * `jobsByRun` maps a run id to its jobs. A run that is itself waiting is reported once at run level and
 * its jobs are skipped: they are queued because the run is, and two rows for one cause read as two
 * problems.
 */
export function judgeQueue(
  { runs = [], jobsByRun = {}, knownGhosts = new Set() },
  { now = Date.now(), limitH = WAIT_LIMIT_H } = {}
) {
  const waited = []
  const acknowledged = []
  const awaitingDelete = new Set(knownGhosts)
  let inFlight = 0
  for (const run of runs) {
    const status = String(run.status ?? '')
    if (status === 'completed') {
      continue
    }
    inFlight++
    // `run_started_at` is the current attempt's start, so a re-run of a week-old run is not a week-old
    // wait. It can be absent, which is the only case the creation time stands in for.
    const queuedSince = run.run_started_at ?? run.created_at
    const runAge = waitedHours(queuedSince, now)
    if (WAITING_STATUSES.has(status) && runAge !== null && runAge > limitH) {
      const jobs = jobsByRun[run.id]
      const emptyJobs = Object.hasOwn(jobsByRun, run.id) && (jobs ?? []).length === 0
      // Only a runner-queued run can be the zero-job kind: `pending` and `waiting` legitimately have
      // jobs, and their remedy is not a runner.
      const ghost = emptyJobs && WAIT_REASON[status] === 'runner'
      const entry = {
        where: ghost ? 'ghost' : 'run',
        status,
        runId: run.id,
        runName: run.name,
        jobName: null,
        labels: [],
        ageHours: runAge,
        url: run.html_url
      }
      if (ghost && awaitingDelete.has(run.id)) {
        awaitingDelete.delete(run.id)
        acknowledged.push(entry)
      } else {
        waited.push(entry)
      }
      continue
    }
    for (const job of jobsByRun[run.id] ?? []) {
      if (!WAITING_STATUSES.has(String(job.status ?? ''))) {
        continue
      }
      // Why not `started_at`: GitHub sets it when the job is *queued*, so it is not evidence that a
      // runner picked the job up. The 2026-10-26 relay job carried `started_at` set, `runner_name: ""`
      // and `runner_id: 0`, and waited 17.5 h — a check gated on `started_at` sees none of that.
      //
      // Why `created_at` is still the right age, measured 2026-11-01 on run 40308443374 and a release
      // run: a job gated on `needs:` gets its record created when it becomes *eligible*, not at run
      // start (shards created 10:35:26 against a run created 10:34:18; the release chain's shards
      // 1m11s after start). So a dependency wait does not read as a queue wait. What this does report
      // after an hour is a job held by an environment rule or a job-level `concurrency:`, and the
      // remedy line says so rather than blaming a runner label.
      if (job.runner_name || job.runner_id) {
        continue
      }
      const jobAge = waitedHours(job.created_at ?? job.started_at ?? queuedSince, now)
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
  return {
    waited,
    acknowledged,
    // An entry that no longer describes a ghost is reported so it can be pruned; it is not a failure,
    // because deleting the run in the UI is the outcome this file exists to allow.
    staleAcknowledged: [...awaitingDelete],
    inFlight,
    oldestHours,
    limitH,
    lookedAt: Object.keys(jobsByRun).length
  }
}

const hours = (value) => `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10}h`

/** A manifest entry that no longer describes a ghost is pruned by hand; it is not a failure. */
const staleLines = (runIds) =>
  runIds.map(
    (runId) => `  remove   ${runId} from ${KNOWN_GHOSTS}: it is no longer a waiting zero-job run`
  )

export function describeVerdict(verdict) {
  const {
    waited,
    acknowledged = [],
    staleAcknowledged = [],
    inFlight,
    limitH,
    oldestHours
  } = verdict
  const lookedAt = verdict.lookedAt ?? 0
  const candidates = verdict.candidates ?? lookedAt
  const footer = `jobs read for ${lookedAt} of ${candidates} run(s) past the ${limitH}h limit`
  const tagOf = (entry) => {
    if (entry.where === 'ghost') {
      return 'NO JOBS'
    }
    return entry.status === 'pending'
      ? 'PENDING'
      : entry.status === 'waiting'
        ? 'WAITING'
        : 'QUEUED '
  }
  const manifestLine = verdict.manifestError
    ? [
        `  manifest  ${KNOWN_GHOSTS} is unreadable (${verdict.manifestError}); nothing is acknowledged`
      ]
    : []
  const rowOf = (entry) =>
    `  ${tagOf(entry)} ${hours(entry.ageHours).padStart(5)}  ${
      entry.where === 'job'
        ? `${entry.runName} / ${entry.jobName}${entry.labels.length > 0 ? ` [${entry.labels.join(',')}]` : ''}`
        : entry.runName
    } — ${entry.url}`

  if (waited.length === 0) {
    const lines = [
      `queued runs: PASS — nothing waiting past ${limitH}h across ${inFlight} in-flight run(s), ${footer}`,
      ...manifestLine
    ]
    for (const entry of acknowledged) {
      lines.push(rowOf(entry))
    }
    if (acknowledged.length > 0) {
      lines.push(
        `  acknowledged: listed in ${KNOWN_GHOSTS}. No API call can cancel or delete these; deleting ` +
          'the run in the Actions UI is what clears them, and nothing else reddens this check meanwhile.'
      )
    }
    lines.push(...staleLines(staleAcknowledged))
    return lines.join('\n')
  }

  const lines = [
    `queued runs: ATTENTION — ${waited.length} waiting past ${limitH}h (oldest ${hours(oldestHours)})`,
    ...manifestLine
  ]
  for (const entry of waited) {
    lines.push(rowOf(entry))
  }
  // Still shown while something else is red: an acknowledged ghost stays visible, it just does not
  // count as the reason.
  for (const entry of acknowledged) {
    lines.push(rowOf(entry))
  }
  if (waited.some((entry) => entry.where === 'ghost')) {
    lines.push(
      '  NO JOBS: a run queued with no jobs at all is a record GitHub will not cancel or force-cancel; ' +
        `delete it in the Actions UI, and list it in ${KNOWN_GHOSTS} if it cannot be cleared soon.`
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
  lines.push(`  ${footer}`)
  lines.push(...staleLines(staleAcknowledged))
  return lines.join('\n')
}

function gh(args) {
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }))
}

/**
 * Recent runs, plus one page per waiting status: a busy day can push an old waiting run past the first
 * page, and a job queued inside a long `in_progress` run is the shape of both incidents.
 */
function fetchRuns() {
  const filters = [
    '',
    '&status=queued',
    '&status=in_progress',
    '&status=waiting',
    '&status=pending',
    '&status=requested'
  ]
  const byId = new Map()
  for (const filter of filters) {
    const page =
      gh(['api', `/repos/${REPO}/actions/runs?per_page=100${filter}`]).workflow_runs ?? []
    for (const run of page) {
      byId.set(run.id, run)
    }
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
  return { jobsByRun, candidates: candidates.length }
}

function main() {
  const json = process.argv.includes('--json')
  // Why the queue is judged anyway when the manifest is unreadable: a manifest entry can only *relax* a
  // finding, so continuing with none acknowledged fails safe — a listed ghost goes red rather than a
  // real wait disappearing behind an exit 2 that names the wrong cause.
  const read = readKnownGhosts()
  const knownGhosts = read instanceof Set ? read : new Set()
  const manifestError = read instanceof Set ? null : read.error
  let verdict
  try {
    const runs = fetchRuns()
    const jobs = fetchJobsByRun(runs)
    verdict = {
      ...judgeQueue({ runs, jobsByRun: jobs.jobsByRun, knownGhosts }),
      candidates: jobs.candidates,
      lookedAt: Object.keys(jobs.jobsByRun).length,
      manifestError
    }
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
