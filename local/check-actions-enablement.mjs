#!/usr/bin/env node
/**
 * Check the fork's GitHub Actions enablement after an upstream merge or sync.
 *
 * Upstream's Actions fleet is disabled at the repository, not in the tree
 * (LOCAL-PATCHES.md -> "local(ci): which workflows are live on this fork"), so a merge that adds
 * or edits a workflow file can re-enable it with no visible diff. An enabled workflow with a
 * pull_request/push/schedule trigger then spends minutes and adds mystery checks to every PR.
 *
 *   node local/check-actions-enablement.mjs          report only; exit 1 on drift
 *   node local/check-actions-enablement.mjs --fix    disable everything that drifted, and stop the
 *                                                   runs it had already started
 *
 * Four things this does beyond comparing names, because a name is not what spends the minutes:
 *
 * - it pins each enabled file's `on:` keys, so a sync that adds `schedule`, `push` or
 *   `pull_request` to a lane is reported rather than inherited (2026-10-31: this used to cover only
 *   the allowed-inert files, which left the eleven required ones unguarded);
 * - it rejects `pull_request_target` on any active file, because that is the trigger that runs with a
 *   write token on code from a fork, and `ci-closed-pr-caches.yml` must stay off;
 * - it rejects a `blacksmith-*` runner label on any active file not recorded in
 *   `ACCEPTED_RUNNER_LABELS`. This fork provisions no Blacksmith runner, so such a job queues until
 *   GitHub's 24 h limit — the 17.5 h and 12 h incidents of 2026-10-26/28, and `timeout-minutes` does
 *   not bound it;
 * - it pages through the workflow list so a 101st file is not invisible, and `--fix` cancels the
 *   queued and in-progress runs of whatever it disables, because disabling a workflow does not stop a
 *   run that is already going.
 *
 * Exit codes: 0 clean, 1 drift or an unverifiable entry, 2 cannot reach the API — "cannot tell" is
 * never a pass.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse } from 'yaml'

const REPO = 'nplez1/orca'
const ROOT = resolve(import.meta.dirname, '..')

// Must stay enabled: the release build, the daily v* tag mirror, the nightly full unit suite, the
// cheap PR lane, the daily health check that watches the rest, and the lanes enabled on
// 2026-10-31 after the cost premise was measured to be zero (LOCAL-PATCHES.md § local(ci)).
export const REQUIRED = [
  '.github/workflows/fork-release.yml',
  '.github/workflows/fork-upstream-tags.yml',
  // Why the unit lane is required and not merely allowed: `AGENTS.md` moved the full unit suite off
  // the PR boundary and onto this nightly lane, so with it disabled nothing verifies `nplez1/main`
  // between merges — a cross-cutting break sits on the release line until someone runs the release
  // gate by hand. Treating "disabled" as drift is the whole point: this is the backstop, and a
  // backstop nobody notices is off is not one. See LOCAL-PATCHES.md § local(ci) before changing it.
  '.github/workflows/fork-main-tests.yml',
  // Why: the cheap PR lane `LOCAL-PATCHES.md` § local(ci) decided on. A lane a ruleset can require is
  // worthless disabled, and nothing else would say so.
  '.github/workflows/fork-pr-gates.yml',
  // Why: this is the check that watches the health checks. An unwatched watchdog is exactly the
  // failure `LOCAL-PATCHES.md` § local(ci) records, so a disabled one is drift, not a preference.
  '.github/workflows/fork-ci-health.yml',
  // Why: the only lane that runs repo-wide oxlint, max-lines, localization catalogs and `pnpm tc` on
  // the release line. It was off from 2026-10-08 to 2026-10-31 and nothing reported that, which is the
  // gap this entry closes.
  '.github/workflows/fork-main-gates.yml',
  // Why: supply-chain audit, path-gated to lockfile/Cargo/patches changes, so it costs nothing on an
  // ordinary PR and covers the one class of change a unit lane cannot see.
  '.github/workflows/dependency-security.yml',
  // Why: mobile parity is first-class in `AGENTS.md` and no PR lane here covered it. Its `push: [main]`
  // leg targets the upstream mirror branch, so that leg only re-tests upstream's own code.
  '.github/workflows/mobile.yml',
  // Why: the headless/remote server path is first-class too. Its `fast_runners` input defaults to true
  // for dispatch and call, so a manual dispatch lands on `blacksmith-*` labels this fork lacks; PR and
  // schedule events pass no input and stay on hosted runners.
  '.github/workflows/node-server-tests.yml',
  // Why: auto-update correctness, ~7 min of macOS across six observed PR runs.
  '.github/workflows/macos-updater-tests.yml',
  // Why: perf regression contract on PRs and nightly, 21 of 24 observed runs green.
  '.github/workflows/performance-contracts.yml'
]

// Inert without a manual dispatch or a caller — active is fine, and so is disabled. Their pinned
// triggers below are the same claim, spelled out.
export const ALLOWED_INERT = [
  '.github/workflows/zcode-account-contract.yml',
  '.github/workflows/unit-module-cache-benchmark.yml',
  '.github/workflows/windows-native-preparation-benchmark.yml',
  '.github/workflows/ci-cache-warmup-platform-jobs.yml',
  '.github/workflows/qualified-orcad-template.yml',
  '.github/workflows/layout-owner-e2e.yml',
  '.github/workflows/dev-channel-win-publish.yml'
]

/**
 * The exact `on:` keys every enabled file is allowed to have, as data rather than as a rule, because a
 * rule cannot tell "this lane grew a schedule" from "this lane always had one". A sync that edits a
 * trigger fails here instead of quietly adding work; a deliberate change updates this table in the
 * same commit, which is what makes the change visible in review.
 *
 * An enabled file with no entry is reported too: pinning is the guard, not an optional extra.
 */
export const EXPECTED_TRIGGERS = {
  '.github/workflows/fork-release.yml': ['workflow_dispatch'],
  '.github/workflows/fork-upstream-tags.yml': ['schedule', 'workflow_dispatch'],
  '.github/workflows/fork-main-tests.yml': ['schedule', 'workflow_dispatch'],
  '.github/workflows/fork-pr-gates.yml': ['pull_request', 'workflow_dispatch'],
  '.github/workflows/fork-ci-health.yml': ['schedule', 'workflow_dispatch'],
  '.github/workflows/fork-main-gates.yml': ['schedule', 'workflow_dispatch', 'push'],
  '.github/workflows/dependency-security.yml': [
    'pull_request',
    'workflow_call',
    'workflow_dispatch'
  ],
  '.github/workflows/mobile.yml': ['pull_request', 'push'],
  '.github/workflows/node-server-tests.yml': [
    'pull_request',
    'workflow_dispatch',
    'workflow_call',
    'schedule'
  ],
  '.github/workflows/macos-updater-tests.yml': ['pull_request', 'workflow_dispatch'],
  '.github/workflows/performance-contracts.yml': ['schedule', 'workflow_dispatch', 'pull_request'],
  '.github/workflows/zcode-account-contract.yml': ['workflow_dispatch'],
  '.github/workflows/unit-module-cache-benchmark.yml': ['workflow_dispatch'],
  '.github/workflows/windows-native-preparation-benchmark.yml': ['workflow_dispatch'],
  '.github/workflows/ci-cache-warmup-platform-jobs.yml': ['workflow_call'],
  '.github/workflows/qualified-orcad-template.yml': ['workflow_call'],
  '.github/workflows/layout-owner-e2e.yml': ['workflow_dispatch'],
  '.github/workflows/dev-channel-win-publish.yml': ['workflow_call']
}

/**
 * Active files that do name a runner this fork does not provision, each with the reason it is still
 * enabled. Anything not here fails the check, so a sync cannot add one silently.
 */
export const ACCEPTED_RUNNER_LABELS = {
  '.github/workflows/node-server-tests.yml':
    'blacksmith-* sits behind `fast_runners`, true only for dispatch and call; PR and schedule events pass no input',
  '.github/workflows/ci-cache-warmup-platform-jobs.yml':
    'dispatch-and-call only, and both of its callers are disabled, so it is dormant until someone starts it'
}

/** This fork provisions no runner from these families; a job asking for one waits for nobody. */
const NON_PROVISIONED = /blacksmith-[a-z0-9.-]+/g

/** A trigger that runs with a write token against a fork's code. Never acceptable on an active file. */
const FORBIDDEN_TRIGGER = 'pull_request_target'

/** Run states that would still execute, i.e. that `--fix` has to cancel rather than wait out. */
export const CANCELLABLE_STATUSES = new Set([
  'queued',
  'requested',
  'waiting',
  'pending',
  'in_progress'
])

/**
 * The `on:` keys of a workflow file. Handles the three shapes GitHub accepts — `on: push`,
 * `on: [push, pull_request]`, and `on: { push: … }` — and the YAML-1.1 reading of `on:`
 * as the boolean `true`, which is what a libYAML-backed parser hands back.
 */
export function triggersOf(text) {
  const doc = parse(text)
  if (doc === null || typeof doc !== 'object') {
    return []
  }
  const on = Object.hasOwn(doc, 'on') ? doc.on : doc[true]
  if (on === null || on === undefined) {
    return []
  }
  if (typeof on === 'string') {
    return [on]
  }
  if (Array.isArray(on)) {
    return on.map(String)
  }
  return typeof on === 'object' ? Object.keys(on) : []
}

/**
 * Every `blacksmith-*` label a file's jobs name, found in the serialised job map so a label inside a
 * `runs-on` expression is caught as readily as a literal one.
 */
export function runnerLabelsOf(text) {
  const doc = parse(text)
  if (doc === null || typeof doc !== 'object') {
    return []
  }
  return [...new Set(JSON.stringify(doc.jobs ?? {}).match(NON_PROVISIONED) ?? [])].sort()
}

/** `gh api --paginate --slurp` yields one object per page; the workflow list is what we want. */
export function workflowsFromPages(pages) {
  return pages.flatMap((page) => page?.workflows ?? [])
}

export function workflowListArgs() {
  return ['api', '--paginate', '--slurp', `repos/${REPO}/actions/workflows?per_page=100`]
}

/** The runs `--fix` must cancel: disabling a workflow does not touch a run already going. */
export function cancellableRuns(runs) {
  return (runs ?? [])
    .filter((run) => CANCELLABLE_STATUSES.has(run.status))
    .map((run) => run.databaseId)
}

const sameTriggers = (left, right) =>
  left.length === right.length &&
  left.every((key) => right.includes(key)) &&
  right.every((key) => left.includes(key))

/**
 * Judge enablement from already-fetched data, so the decision is testable without a network.
 *
 * `facts` maps a workflow path to `{ triggers, runnerLabels }`, or to `{ error }` when the file could
 * not be read — a missing entry is reported too, never treated as "inert, presumably".
 */
export function judgeEnablement(
  { workflows, facts = {} },
  {
    required = REQUIRED,
    allowedInert = ALLOWED_INERT,
    expected = EXPECTED_TRIGGERS,
    acceptedRunners = ACCEPTED_RUNNER_LABELS
  } = {}
) {
  const allowed = new Set([...required, ...allowedInert])
  const byPath = new Map(workflows.map((workflow) => [workflow.path, workflow]))
  const active = workflows.filter((w) => w.state === 'active')
  const drift = active.filter((w) => !allowed.has(w.path))
  const missing = required
    .map((path) => ({ path, workflow: byPath.get(path) }))
    .filter(({ workflow }) => !workflow || workflow.state !== 'active')
    .map(({ path, workflow }) => ({ path, state: workflow ? workflow.state : 'absent' }))
  const stale = Object.keys(expected)
    .filter((path) => !byPath.has(path))
    .map((path) => ({ path, reason: 'no workflow file by that path on the repository' }))

  const triggerDrift = []
  const unpinned = []
  const unapprovedRunners = []
  const pullRequestTarget = []
  const unreadable = []
  for (const workflow of active) {
    // A file that is active without being allowed is already a disable target; checking its triggers
    // or labels too would report one problem as three.
    if (!allowed.has(workflow.path)) {
      continue
    }
    const entry = facts[workflow.path]
    if (entry === undefined) {
      unreadable.push({ path: workflow.path, reason: 'not read, so its triggers are unproven' })
      continue
    }
    if (!Array.isArray(entry.triggers)) {
      unreadable.push({ path: workflow.path, reason: entry.error ?? 'unreadable' })
      continue
    }
    if (entry.triggers.includes(FORBIDDEN_TRIGGER)) {
      pullRequestTarget.push({ path: workflow.path })
    }
    const labels = entry.runnerLabels ?? []
    if (labels.length > 0 && !Object.hasOwn(acceptedRunners, workflow.path)) {
      unapprovedRunners.push({ path: workflow.path, labels })
    }
    const pinned = expected[workflow.path]
    if (pinned === undefined) {
      unpinned.push({ path: workflow.path, all: entry.triggers })
      continue
    }
    if (!sameTriggers(entry.triggers, pinned)) {
      triggerDrift.push({ path: workflow.path, expected: pinned, all: entry.triggers })
    }
  }

  // Everything `--fix` is allowed to turn off. A lane whose trigger shape changed is stopped until a
  // human looks, because the shape is what decides whether it spends minutes on every PR.
  const disableTargets = [
    ...drift.map((entry) => ({
      path: entry.path,
      id: entry.id,
      why: "active but not on the fork's live list"
    })),
    ...triggerDrift.map((entry) => ({
      path: entry.path,
      id: byPath.get(entry.path)?.id ?? null,
      why: 'its triggers changed shape'
    })),
    ...unpinned.map((entry) => ({
      path: entry.path,
      id: byPath.get(entry.path)?.id ?? null,
      why: 'active with no pinned triggers'
    }))
  ]

  const problems =
    disableTargets.length +
    missing.length +
    stale.length +
    unreadable.length +
    unapprovedRunners.length +
    pullRequestTarget.length
  return {
    total: workflows.length,
    activeCount: active.length,
    drift,
    missing,
    stale,
    triggerDrift,
    unpinned,
    unapprovedRunners,
    pullRequestTarget,
    unreadable,
    disableTargets,
    ok: problems === 0
  }
}

/**
 * The problems left after a run: under `--fix`, a target that was disabled (and had its runs
 * cancelled) is resolved. One that failed to disable is not — and neither is one that was disabled
 * but still has a run this command could not cancel.
 */
export function residualProblems({ verdict, fix = false, disabled = [], failed = [] }) {
  const handled = new Set(fix ? disabled : [])
  for (const path of failed) {
    handled.delete(path)
  }
  const outstanding = verdict.disableTargets.filter((target) => !handled.has(target.path)).length
  return (
    outstanding +
    verdict.missing.length +
    verdict.stale.length +
    verdict.unreadable.length +
    verdict.unapprovedRunners.length +
    verdict.pullRequestTarget.length
  )
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
}

/** Read the pinned facts from this checkout, so the claim is the tree's and not the API's. */
export function readFacts(paths, root = ROOT) {
  const facts = {}
  for (const path of paths) {
    const file = join(root, path)
    if (!existsSync(file)) {
      facts[path] = { error: 'not in this checkout' }
      continue
    }
    try {
      const text = readFileSync(file, 'utf8')
      facts[path] = { triggers: triggersOf(text), runnerLabels: runnerLabelsOf(text) }
    } catch (error) {
      facts[path] = { error: firstLine(error) }
    }
  }
  return facts
}

function firstLine(error) {
  return String(error?.message ?? error)
    .split('\n')[0]
    .trim()
}

/**
 * Print the verdict, disabling and cancelling under `--fix`, and return the paths it handled plus
 * the ones it could not.
 *
 * `runGh` is a parameter so the two failure modes a real `gh` hides — disabling succeeded but the run
 * lookup failed, and the cancel itself failing — are covered by tests without a network.
 */
export function applyFixes(verdict, fix, runGh = gh, log = console.log) {
  const disabled = []
  const failed = []
  for (const target of verdict.disableTargets) {
    if (!fix) {
      continue
    }
    if (target.id === null) {
      failed.push(target.path)
      console.error(`  FAILED   no workflow id to disable for ${target.path}`)
      continue
    }
    try {
      runGh(['workflow', 'disable', String(target.id), '--repo', REPO])
      disabled.push(target.path)
      log(`  disabled ${target.path} (${target.why})`)
    } catch (error) {
      failed.push(target.path)
      console.error(`  FAILED   could not disable ${target.path}: ${firstLine(error)}`)
      continue
    }
    // Cancelling is a second step on purpose: disabling does not stop a run already going, and the
    // run ids are read by workflow id (which works for a disabled workflow) rather than by path.
    try {
      const runs = cancellableRuns(
        JSON.parse(
          runGh([
            'run',
            'list',
            '--repo',
            REPO,
            '--workflow',
            String(target.id),
            '--limit',
            '50',
            '--json',
            'databaseId,status'
          ])
        )
      )
      for (const runId of runs) {
        runGh(['run', 'cancel', String(runId), '--repo', REPO])
      }
      if (runs.length > 0) {
        log(`  cancelled ${runs.length} run(s) of ${target.path} that were still going`)
      }
    } catch (error) {
      failed.push(target.path)
      const reason = firstLine(error)
      console.error(
        `  FAILED   ${target.path} is disabled, but its running jobs could not be cancelled: ${reason}`
      )
    }
  }
  return { disabled, failed }
}

function report(verdict, fix) {
  console.log(
    `check-actions: ${verdict.total} workflows on ${REPO}, ${verdict.activeCount} active ` +
      `(${REQUIRED.length} required + ${ALLOWED_INERT.length} allowed-inert)`
  )
  for (const w of verdict.drift) {
    console.log(`  DRIFT    active but not on the fork's live list: ${w.path} — ${w.name}`)
  }
  for (const m of verdict.missing) {
    console.log(`  MISSING  required but ${m.state}: ${m.path}`)
  }
  for (const s of verdict.stale) {
    console.log(`  STALE    pinned entry with ${s.reason}: ${s.path}`)
  }
  for (const t of verdict.triggerDrift) {
    console.log(
      `  TRIGGER  pinned [${t.expected.join(', ')}] but the file fires on [${t.all.join(', ')}]: ${t.path}`
    )
  }
  for (const u of verdict.unpinned) {
    console.log(`  UNPINNED active but no triggers pinned, so its shape is unproven: ${u.path}`)
  }
  for (const u of verdict.unapprovedRunners) {
    console.log(
      `  RUNNER   names a runner this fork does not provision: ${u.path} (${u.labels.join(', ')})`
    )
  }
  for (const p of verdict.pullRequestTarget) {
    console.log(
      `  TARGET   active with ${FORBIDDEN_TRIGGER}, which runs with a write token: ${p.path}`
    )
  }
  for (const u of verdict.unreadable) {
    console.log(`  UNKNOWN  cannot read the workflow: ${u.path}: ${u.reason}`)
  }

  const { disabled, failed } = applyFixes(verdict, fix)
  const residual = residualProblems({ verdict, fix, disabled, failed })
  if (residual > 0) {
    if (verdict.disableTargets.length > 0 && !fix) {
      console.log('  fix: node local/check-actions-enablement.mjs --fix')
    }
    if (
      verdict.triggerDrift.length > 0 ||
      verdict.unpinned.length > 0 ||
      verdict.stale.length > 0
    ) {
      console.log(
        '  a workflow changed the triggers it fires on, or no longer exists: if that is intended, ' +
          'update EXPECTED_TRIGGERS and record it in LOCAL-PATCHES.md § local(ci)'
      )
    }
    if (verdict.unapprovedRunners.length > 0 || verdict.pullRequestTarget.length > 0) {
      console.log(
        '  this one is not auto-fixed: decide whether the file may be active at all, and record the ' +
          'decision in LOCAL-PATCHES.md § local(ci)'
      )
    }
    for (const path of failed) {
      // A workflow can be off and still be a problem: disabling does not stop a run already going.
      console.log(
        disabled.includes(path)
          ? `  STILL    ${path} is disabled, but a run of it may still be going`
          : `  STILL    ${path} could not be disabled`
      )
    }
  }
  return residual
}

function main() {
  const fix = process.argv.includes('--fix')
  let workflows
  try {
    workflows = workflowsFromPages(JSON.parse(gh(workflowListArgs())))
  } catch (error) {
    console.error(`check-actions: gh api failed: ${firstLine(error)}`)
    process.exit(2)
  }

  const verdict = judgeEnablement({
    workflows,
    facts: readFacts(Object.keys(EXPECTED_TRIGGERS), ROOT)
  })
  if (report(verdict, fix) > 0) {
    process.exit(1)
  }
  console.log('  OK')
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main()
}
