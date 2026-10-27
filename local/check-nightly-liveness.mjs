#!/usr/bin/env node
/**
 * Report whether the nightly unit backstop is actually running.
 *
 * The backstop is `.github/workflows/fork-main-tests.yml`. Its last passing run was 2026-10-08; the
 * 2026-10-26 schedule then queued on a job whose runner label this fork does not provision, never
 * completed, and `cancel-in-progress: false` would have blocked every later night behind it. A night
 * gone silently wrong is worse than no nightly, which is why this exists as a check.
 *
 * Exit codes are the contract: 0 healthy, 1 stale or wedged, 2 cannot tell. "Cannot tell" is not a
 * pass — it is reported separately so a missing `gh` never reads as a green nightly.
 */
import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
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

// Every path emits the same keys, with null where there is nothing to report, so a consumer of --json
// can rely on the shape rather than on which branch produced the verdict.
const EMPTY_FACTS = {
  runId: null,
  status: null,
  conclusion: null,
  ageHours: null,
  headSha: null,
  event: null,
  runsInLastDay: 0,
  verdictRunId: null,
  verdictAgeHours: null,
  verdictlessRuns: 0
}

const run = promisify(execFile)

const FIELDS = ['databaseId', 'status', 'conclusion', 'createdAt', 'headSha', 'event', 'url'].join(
  ','
)

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
  return JSON.parse(stdout)
}

const ageHours = (iso, now) => (now - Date.parse(iso)) / HOUR

/**
 * Conclusions that carry no verdict about the code. A cancelled run says a human or a timeout stopped
 * it, and reading that as "red" is how a deliberately cancelled run raised a false alarm on
 * 2026-10-27 while also hiding the last run that actually passed.
 */
const VERDICTLESS = new Set(['cancelled', 'skipped', 'neutral', null, undefined])

const byRecency = (runs) =>
  [...runs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))

/** Judge liveness from already-fetched runs, so the decision is testable without a network. */
export function judgeLiveness(runs, now = Date.now()) {
  if (!Array.isArray(runs) || runs.length === 0) {
    return {
      ...EMPTY_FACTS,
      ok: false,
      code: 1,
      summary: `no run of ${WORKFLOW} has ever been recorded — the backstop is not wired up`
    }
  }

  // Two clocks: the schedule's (any run at all proves the cron fires) and the backstop's (only a
  // completed run proves the suite still passes). Cancelling a run advances one and not the other.
  const ordered = byRecency(runs)
  const newest = ordered[0]
  const verdictRun = ordered.find((r) => r.status === 'completed' && !VERDICTLESS.has(r.conclusion))
  const age = ageHours(newest.createdAt, now)
  const verdictAge = verdictRun ? ageHours(verdictRun.createdAt, now) : null
  const inFlight = newest.status !== 'completed'
  const lastDay = runs.filter((r) => ageHours(r.createdAt, now) <= 24).length
  const verdictless = ordered.filter(
    (r) => r.status === 'completed' && VERDICTLESS.has(r.conclusion)
  )

  const facts = {
    runId: newest.databaseId,
    status: newest.status,
    conclusion: newest.conclusion,
    ageHours: Math.round(age * 10) / 10,
    headSha: newest.headSha?.slice(0, 10) ?? null,
    event: newest.event,
    runsInLastDay: lastDay,
    verdictRunId: verdictRun?.databaseId ?? null,
    verdictAgeHours: verdictAge === null ? null : Math.round(verdictAge * 10) / 10,
    verdictlessRuns: verdictless.length
  }

  const noVerdictNote =
    verdictless.length > 0
      ? ` (${verdictless.length} run(s) carried no verdict: ${verdictless
          .map((r) => r.conclusion ?? r.status)
          .join(', ')})`
      : ''

  if (inFlight && age > WEDGED_AFTER_H) {
    return {
      ...facts,
      ok: false,
      code: 1,
      summary:
        `run ${newest.databaseId} has been ${newest.status} for ${facts.ageHours}h — that is a wedged ` +
        'run, not a slow one. Check which job is stuck (a runner label this fork does not provision ' +
        'is the known cause) and cancel it: the next scheduled run supersedes it, so leaving it costs ' +
        'a night of coverage rather than the run itself.'
    }
  }
  // Why an in-flight run does not answer for the backstop: it has produced no verdict yet, so
  // returning early here would report PASS for up to WEDGED_AFTER_H after yesterday went red, and
  // would hide a verdict that is already stale. The verdict decides; the in-flight run is a note.
  const inFlightNote = inFlight
    ? `; run ${newest.databaseId} is ${newest.status} (${facts.ageHours}h) and has no verdict yet`
    : ''
  if (age > STALE_AFTER_H) {
    return {
      ...facts,
      ok: false,
      code: 1,
      summary:
        `newest run is ${facts.ageHours}h old (${newest.conclusion ?? newest.status}), past the ` +
        `${STALE_AFTER_H}h threshold for a ${CRON_UTC_HOUR}:${String(CRON_UTC_MINUTE).padStart(2, '0')} ` +
        `UTC daily schedule — the cron is not firing, or the workflow is disabled.${noVerdictNote}`
    }
  }
  if (!verdictRun) {
    return {
      ...facts,
      ok: false,
      code: 1,
      summary:
        'no completed run in the fetched history has produced a verdict — the schedule is ' +
        `firing (newest ${facts.ageHours}h ago) but nothing has actually run the suite${inFlightNote}${noVerdictNote}`
    }
  }
  if (verdictAge > STALE_AFTER_H) {
    return {
      ...facts,
      ok: false,
      code: 1,
      summary:
        `the newest verdict is ${facts.verdictAgeHours}h old (${verdictRun.conclusion}) even though ` +
        `a run exists ${facts.ageHours}h ago${inFlightNote}${noVerdictNote} — read that as the ` +
        'backstop being down, not as green'
    }
  }
  const verdict = verdictRun.conclusion === 'success' ? 'green' : `red (${verdictRun.conclusion})`
  return {
    ...facts,
    ok: verdictRun.conclusion === 'success',
    code: verdictRun.conclusion === 'success' ? 0 : 1,
    summary: `nightly ${verdict} at ${facts.verdictAgeHours}h old, ${lastDay} run(s) in the last 24h${verdictRun.databaseId === newest.databaseId ? '' : `; newest run ${newest.databaseId} was ${newest.conclusion ?? newest.status}`}${inFlightNote}${noVerdictNote}`
  }
}

async function main() {
  const json = process.argv.includes('--json')
  let runs
  try {
    runs = await fetchRuns()
  } catch (error) {
    const message = error.code === 'ENOENT' ? 'gh is not installed' : error.message.split('\n')[0]
    if (json) {
      console.log(
        JSON.stringify(
          { ...EMPTY_FACTS, ok: false, code: 2, summary: `cannot read run history: ${message}` },
          null,
          2
        )
      )
    } else {
      console.error(`nightly liveness: cannot tell — ${message}`)
    }
    process.exit(2)
  }

  const verdict = judgeLiveness(runs)
  if (json) {
    console.log(JSON.stringify(verdict, null, 2))
  } else {
    const line = verdict.ok ? 'nightly liveness: PASS' : 'nightly liveness: ATTENTION'
    console.error(`${line} — ${verdict.summary}`)
  }
  process.exit(verdict.code)
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  await main()
}
