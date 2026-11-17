#!/usr/bin/env node
/**
 * Report a fork-owned lane that is red on the release line.
 *
 * Why this exists: `check-actions-enablement` watches whether a lane is *enabled* and
 * `check-nightly-liveness` watches one lane (the nightly), so nothing watched whether a lane had run
 * and failed. On 2026-11-12 → 11-15 `Mirror upstream release tags` failed on every scheduled day —
 * upstream re-pointed `v1.4.256`, the guard refused to move a tag, and the state needed a person — and
 * the only record was four failure emails. No issue, no `agent:auto`, no delegation, because
 * `ci-health-report.mjs` owns exactly one issue and it carried only its three checks.
 *
 * So this is the fourth check, and the scope is deliberately narrow:
 *
 *   - **fork-owned lanes only** (`REQUIRED` ∩ the fork-owned workflow paths). An upstream lane this
 *     fork enabled fails here for upstream's reasons, and its remedy is a sync or a disable, not a red
 *     row that says "someone should look".
 *   - **the release line only** (`--branch main`). A red on a PR branch cannot merge and is fixed by
 *     pushing; reading PR runs would redden the issue every time a work-in-progress was pushed. A
 *     PR-triggered lane has nothing to judge here unless someone dispatched it on `main`, which
 *     `DISPATCH_ONLY` covers.
 *   - **the newest verdict, not every run.** A lane whose newest verdict is green has been fixed —
 *     which is what makes this self-healing instead of a day-long tape of everything that reddened.
 *   - **`cancelled` is not a verdict.** `concurrency.cancel-in-progress` supersedes runs on every push,
 *     and 11 of the 21 non-success runs in the 2026-11-16 window were cancellations of that kind.
 *
 *   node local/check-fork-lane-red.mjs            report
 *   node local/check-fork-lane-red.mjs --json     the same facts as JSON
 *
 * Exit codes are the contract: 0 nothing red, 1 a red a scoped fix can clear, 3 a red only a person may
 * decide, 2 cannot tell. "Cannot tell" is not a pass — a missing `gh` must never read as a green lane.
 *
 * Exit 3 withholds `agent:auto` from the whole issue rather than from this check alone, which is
 * `judgeDelegation`'s recorded rule: an agent handed a red it may not resolve resolves it anyway.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { REQUIRED } from './actions-enablement-contract.mjs'
import { isForkOwnedPath } from './fork-owned-paths.mjs'

const REPO = 'nplez1/orca'
const BRANCH = 'main'
const HOUR = 60 * 60 * 1000
/** Newest-first depth per lane: enough to see past a run of cancellations to the last real verdict. */
export const RUNS_PER_LANE = 10

/** Conclusions that are a red. `timed_out` and `startup_failure` are failures with no test in them. */
export const RED_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure'])

/**
 * Conclusions that are not a verdict about the lane: `cancelled` because a newer push superseded it,
 * `skipped` because a path filter or a `needs:` said no, `stale` because a newer run took over the
 * concurrency group, and `action_required` because the run is waiting for someone to approve it.
 */
export const NOT_A_VERDICT = new Set(['cancelled', 'skipped', 'stale', 'action_required'])

/**
 * Lanes a red from which is a decision, never a scoped fix.
 *
 * The tag mirror's failures are all a person's: its guard refusing to run, because a `v*` tag this fork
 * already publishes exists upstream at another commit — so adopting upstream's commit for that name or
 * dropping the name from the mirror is a release decision no agent may take — and `FORK_TAG_MIRROR_TOKEN`
 * missing or expired, which is a secret rotation. Exit 3 is right for both even though only one of them
 * is a disagreement: rotating a token is a person's job too.
 */
export const DECISION_LANES = {
  '.github/workflows/fork-upstream-tags.yml':
    'the tag guard refused to move a tag, so a person adopts upstream’s commit for that name or stops ' +
    'mirroring it — or FORK_TAG_MIRROR_TOKEN is missing or expired and needs rotating'
}

/**
 * Lanes whose only trigger is a dispatch, so the newest verdict does not move on a merge.
 *
 * Why it is a row in the output and not a fifth exclusion: `fork-release` is the only *required* lane
 * that builds `native/computer-use-macos`, so a macOS native break has no other signal from a lane this
 * check judges. But its red does not clear when a fix merges — only a dispatch clears it — and for
 * `fork-release` that dispatch publishes a release, which is not part of the fix. Saying so is what
 * stops the delegation from reading as "re-run the lane".
 */
export const DISPATCH_ONLY = {
  '.github/workflows/fork-release.yml':
    'only a dispatch clears this row, and a dispatch publishes a release — fix the failure, then the ' +
    'release decision is someone’s to make',
  '.github/workflows/fork-pr-gates.yml':
    'its runs on main come only from a dispatch, so a merge does not clear this row — dispatch it again ' +
    'on `main` once the fix is in, or against the branch under test'
}

/**
 * Lanes whose red is already reported, so a row here would be the same fact twice.
 *
 * The nightly has `check-nightly-liveness`, which reports the red *and* separates "stopped firing" from
 * "fired and failed" — a distinction this check cannot make. The health lane is the reporter itself:
 * its own red (an unset delegate token, a crash) is the one signal that cannot be delivered inside the
 * issue it maintains, so it stays a failure email. That gap is real and stated rather than hidden.
 */
export const COVERED_ELSEWHERE = {
  '.github/workflows/fork-main-tests.yml':
    'check-nightly-liveness reports this lane, and it distinguishes "not firing" from "fired and failed"',
  '.github/workflows/fork-ci-health.yml':
    'this lane is the reporter — its own red is the one signal the issue it maintains cannot carry'
}

/** The lanes this check judges: fork-owned, required, and not already reported. */
export function lanePaths(required = REQUIRED) {
  return required
    .filter((path) => isForkOwnedPath(path))
    .filter((path) => !Object.hasOwn(COVERED_ELSEWHERE, path))
    .sort()
}

/**
 * The newest run that is a verdict about the lane, or null when there is none.
 *
 * `status` is read as well as `conclusion`: a run that has not finished reports a null or empty
 * conclusion, and reading that as a verdict marks the lane green. That is the silent green this file
 * exists to end, and it is not hypothetical — a queued zero-job run (`queued-known-ghosts.json` lists
 * two of that shape) sits at the top of the list and masks the lane until something newer lands.
 */
export function newestVerdict(runs) {
  return (
    runs.find(
      (run) =>
        run.status === 'completed' &&
        run.conclusion != null &&
        run.conclusion !== '' &&
        !NOT_A_VERDICT.has(String(run.conclusion))
    ) ?? null
  )
}

/** Null-safe, so a run with no `created_at` reads as an unknown age rather than `NaNh`. */
const ageHours = (iso, now) => {
  const at = Date.parse(iso ?? '')
  return Number.isFinite(at) ? (now - at) / HOUR : null
}
const hours = (value) =>
  value === null ? '—' : `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10}h`

/**
 * Judge lanes from runs already fetched, so the decision is testable without a network.
 *
 * A lane with no verdict run is `no-runs`, not a finding: a PR-only lane and a path-gated lane both
 * legitimately have nothing on the release line, and `check-actions-enablement` is what reports a lane
 * that is enabled but silent for the wrong reason.
 */
export function judgeLanes({ lanes = [], runsByLane = {} }, { now = Date.now() } = {}) {
  const rows = lanes.map((path) => {
    const run = newestVerdict(runsByLane[path] ?? [])
    if (run === null) {
      return { path, state: 'no-runs', conclusion: null, ageHours: null, url: null, event: null }
    }
    return {
      path,
      state: RED_CONCLUSIONS.has(String(run.conclusion)) ? 'red' : 'green',
      conclusion: String(run.conclusion),
      ageHours: ageHours(run.createdAt, now),
      url: run.url ?? null,
      event: run.event ?? null
    }
  })
  return {
    rows,
    red: rows.filter((row) => row.state === 'red' && !Object.hasOwn(DECISION_LANES, row.path)),
    decisions: rows.filter((row) => row.state === 'red' && Object.hasOwn(DECISION_LANES, row.path)),
    green: rows.filter((row) => row.state === 'green').length,
    noRuns: rows.filter((row) => row.state === 'no-runs').length
  }
}

export function describeVerdict(verdict) {
  const { rows, red, decisions, green, noRuns } = verdict
  const worst = [...red, ...decisions].reduce(
    (oldest, row) => (oldest === null || row.ageHours > oldest ? row.ageHours : oldest),
    null
  )
  const redCount = red.length + decisions.length
  const oldest = worst === null ? '' : ` (oldest verdict ${hours(worst)})`
  const header =
    redCount === 0
      ? `fork lanes: PASS — ${green} green on ${BRANCH}, ${noRuns} with no verdict to read`
      : `fork lanes: ATTENTION — ${redCount} red on ${BRANCH}${oldest}`
  const rowOf = (row) => {
    const tag =
      row.state === 'red'
        ? Object.hasOwn(DECISION_LANES, row.path)
          ? 'DECISION'
          : 'RED     '
        : row.state === 'green'
          ? 'OK      '
          : 'NO RUNS '
    const name = basename(row.path).replace(/\.ya?ml$/, '')
    return `  ${tag} ${name.padEnd(18)} ${String(row.conclusion ?? '—').padEnd(10)} ${hours(row.ageHours).padStart(5)}  ${row.url ?? ''}`.trimEnd()
  }
  const lines = [header, ...rows.map(rowOf)]
  if (red.length > 0) {
    lines.push(
      '  RED: a fork lane red on main is nobody’s pull request — fix it on the release line, and the ' +
        'newest verdict goes green with that run.'
    )
    for (const row of red.filter((entry) => Object.hasOwn(DISPATCH_ONLY, entry.path))) {
      lines.push(`  DISPATCH: ${row.path} — ${DISPATCH_ONLY[row.path]}.`)
    }
  }
  if (decisions.length > 0) {
    for (const row of decisions) {
      lines.push(`  DECISION: ${row.path} — ${DECISION_LANES[row.path]}.`)
    }
    lines.push('  Nothing here is delegated: this check exits 3, which withholds `agent:auto`.')
  }
  if (noRuns > 0) {
    lines.push(
      '  NO RUNS: no push, schedule or dispatch run on main to judge — ordinary for a PR-triggered lane, ' +
        'and a path-gated lane is silent until a push touches its paths.'
    )
  }
  return lines.join('\n')
}

const firstLine = (error) =>
  String(error?.stderr ?? error?.message ?? error ?? '')
    .split('\n')[0]
    .trim()

function fetchLaneRuns(path) {
  const workflow = basename(path)
  const output = execFileSync(
    'gh',
    [
      'api',
      `/repos/${REPO}/actions/workflows/${workflow}/runs` +
        `?branch=${BRANCH}&per_page=${RUNS_PER_LANE}&exclude_pull_requests=true`
    ],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
  )
  return (
    (JSON.parse(output).workflow_runs ?? [])
      // `exclude_pull_requests` only empties each run's `pull_requests` array — it does not remove the
      // runs — so a PR from a fork whose head branch happens to be named `main` would pass `branch=main`.
      .filter((run) => run.event !== 'pull_request')
      .map((run) => ({
        id: run.id,
        // A finished run's conclusion; `status` is what separates "has not finished" from "green".
        status: run.status ?? null,
        conclusion: run.conclusion ?? null,
        event: run.event ?? null,
        createdAt: run.created_at ?? null,
        url: run.html_url ?? null
      }))
  )
}

/**
 * The exit code a verdict means, which is the contract `judgeDelegation` reads.
 *
 * Why 3 outranks 1: `judgeDelegation` withholds `agent:auto` from the whole issue once any check exits 3,
 * so reporting 1 while a decision is also present would hand the pipeline a red it may not resolve.
 */
export function exitCodeFor(verdict) {
  if (verdict.decisions.length > 0) {
    return 3
  }
  return verdict.red.length > 0 ? 1 : 0
}

function main() {
  const json = process.argv.includes('--json')
  const lanes = lanePaths()
  const runsByLane = {}
  const unreadable = []
  for (const path of lanes) {
    try {
      runsByLane[path] = fetchLaneRuns(path)
    } catch (error) {
      unreadable.push({ path, why: firstLine(error) })
    }
  }
  // Any lane left unread is a harness problem, not a scoped defect: a partial read that reported the
  // other lanes green would be the silent-success failure this file exists to end.
  if (unreadable.length > 0) {
    console.error(
      `fork lanes: cannot tell — ${unreadable.map((entry) => `${entry.path} (${entry.why})`).join('; ')}`
    )
    process.exit(2)
  }
  const verdict = judgeLanes({ lanes, runsByLane })
  console.log(json ? JSON.stringify(verdict, null, 2) : describeVerdict(verdict))
  process.exit(exitCodeFor(verdict))
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  // Why: an uncaught throw exits 1, the same code as "attention", and `ci-health-report` delegates
  // exit 1 — so a crash must report 2 (cannot tell) instead of masquerading as a red lane.
  try {
    main()
  } catch (error) {
    console.error(`fork lanes: cannot tell — ${firstLine(error)}`)
    process.exit(2)
  }
}
