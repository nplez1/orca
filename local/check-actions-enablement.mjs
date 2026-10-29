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
 * Three things this does beyond comparing names, because a name is not what spends the minutes: it
 * reads each allowed-inert file's `on:` keys and fails when one gained a trigger that fires without a
 * human (`schedule`, `push`, `pull_request`); it pages through the workflow list so a 101st file is
 * not invisible; and `--fix` cancels the queued and in-progress runs of whatever it disables, because
 * disabling a workflow does not stop a run that is already going — that is how "Unit transform cache
 * producer" wedged for 12 hours on 2026-10-28. Exit codes: 0 clean, 1 drift or an unverifiable entry,
 * 2 cannot reach the API — "cannot tell" is never a pass.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse } from 'yaml'

const REPO = 'nplez1/orca'
const ROOT = resolve(import.meta.dirname, '..')

// Must stay enabled: the release build, the daily v* tag mirror, the nightly full unit suite, the
// cheap PR lane, and the daily health check that watches the other four.
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
  '.github/workflows/fork-ci-health.yml'
]

// Inert without a manual dispatch or a caller — active is fine, disabled is also fine.
export const ALLOWED_INERT = [
  '.github/workflows/zcode-account-contract.yml',
  '.github/workflows/unit-module-cache-benchmark.yml',
  '.github/workflows/windows-native-preparation-benchmark.yml',
  '.github/workflows/ci-cache-warmup-platform-jobs.yml',
  '.github/workflows/qualified-orcad-template.yml',
  '.github/workflows/layout-owner-e2e.yml',
  '.github/workflows/dev-channel-win-publish.yml'
]

/** Inert means nothing fires it but a human dispatch or a caller. */
export const INERT_TRIGGERS = new Set(['workflow_dispatch', 'workflow_call'])

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
 * `on: [push, pull_request]`, and the `on: { push: … }` map — and the YAML-1.1 reading of `on:`
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

/**
 * Judge enablement from already-fetched data, so the decision is testable without a network.
 * `triggers` maps a workflow path to its `on:` keys, or to `{ error }` when the file could not be
 * read — a missing entry is reported too, never treated as "inert, presumably".
 */
export function judgeEnablement(
  { workflows, triggers = {} },
  { required = REQUIRED, allowedInert = ALLOWED_INERT } = {}
) {
  const allowed = new Set([...required, ...allowedInert])
  const byPath = new Map(workflows.map((workflow) => [workflow.path, workflow]))
  const active = workflows.filter((w) => w.state === 'active')
  const drift = active.filter((w) => !allowed.has(w.path))
  const missing = required
    .map((path) => ({ path, workflow: byPath.get(path) }))
    .filter(({ workflow }) => !workflow || workflow.state !== 'active')
    .map(({ path, workflow }) => ({ path, state: workflow ? workflow.state : 'absent' }))
  const stale = allowedInert
    .filter((path) => !byPath.has(path))
    .map((path) => ({ path, reason: 'no workflow file by that path on the repository' }))

  const overTriggered = []
  const unreadable = []
  for (const path of allowedInert) {
    const facts = triggers[path]
    if (facts === undefined) {
      unreadable.push({ path, reason: 'triggers not supplied, so "inert" is unproven' })
      continue
    }
    if (!Array.isArray(facts)) {
      unreadable.push({ path, reason: facts.error })
      continue
    }
    const extra = facts.filter((trigger) => !INERT_TRIGGERS.has(trigger))
    if (extra.length > 0) {
      overTriggered.push({ path, triggers: extra, all: facts })
    }
  }

  // Everything `--fix` is allowed to turn off. An allowed-inert entry that fires on its own is
  // disabled too: "disabled is also fine" is the entry's own contract.
  const disableTargets = [
    ...drift.map((w) => ({
      path: w.path,
      id: w.id,
      why: "active but not on the fork's live list"
    })),
    ...overTriggered.map((o) => ({
      path: o.path,
      id: byPath.get(o.path)?.id ?? null,
      why: `allowed-inert, but it fires on ${o.triggers.join(', ')}`
    }))
  ]

  const problems = disableTargets.length + missing.length + stale.length + unreadable.length
  return {
    total: workflows.length,
    activeCount: active.length,
    drift,
    missing,
    stale,
    overTriggered,
    unreadable,
    disableTargets,
    ok: problems === 0
  }
}

/**
 * The problems left after a run: under `--fix`, a target that was disabled (and had its runs
 * cancelled) is resolved; one that failed to disable is not.
 */
export function residualProblems({ verdict, fix = false, disabled = [] }) {
  const handled = new Set(fix ? disabled : [])
  const outstanding = verdict.disableTargets.filter((target) => !handled.has(target.path)).length
  return outstanding + verdict.missing.length + verdict.stale.length + verdict.unreadable.length
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
}

/** Read the `on:` keys of the allowlisted files in this checkout, so the claim is the tree's. */
export function readTriggers(paths, root = ROOT) {
  const triggers = {}
  for (const path of paths) {
    const file = join(root, path)
    if (!existsSync(file)) {
      triggers[path] = { error: 'not in this checkout' }
      continue
    }
    try {
      triggers[path] = triggersOf(readFileSync(file, 'utf8'))
    } catch (error) {
      triggers[path] = { error: firstLine(error) }
    }
  }
  return triggers
}

function firstLine(error) {
  return String(error?.message ?? error)
    .split('\n')[0]
    .trim()
}

/**
 * Print the verdict, disabling and cancelling under `--fix`, and return the paths it handled plus
 * the ones it could not. Kept out of `main` so the arithmetic is testable.
 */
function apply(verdict, fix) {
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
      gh(['workflow', 'disable', String(target.id), '--repo', REPO])
      const runs = cancellableRuns(
        JSON.parse(
          gh([
            'run',
            'list',
            '--repo',
            REPO,
            '--workflow',
            target.path,
            '--limit',
            '50',
            '--json',
            'databaseId,status'
          ])
        )
      )
      for (const runId of runs) {
        gh(['run', 'cancel', String(runId), '--repo', REPO])
      }
      disabled.push(target.path)
      const cancelled = runs.length > 0 ? `, cancelled ${runs.length} run(s) already going` : ''
      console.log(`  disabled ${target.path} (${target.why})${cancelled}`)
    } catch (error) {
      failed.push(target.path)
      console.error(`  FAILED   could not disable ${target.path}: ${firstLine(error)}`)
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
    console.log(`  STALE    allowed-inert entry with ${s.reason}: ${s.path}`)
  }
  for (const o of verdict.overTriggered) {
    console.log(
      `  TRIGGER  allowed-inert but fires on ${o.triggers.join(', ')} ` +
        `(on: ${o.all.join(', ')}): ${o.path}`
    )
  }
  for (const u of verdict.unreadable) {
    console.log(`  UNKNOWN  cannot read the triggers of ${u.path}: ${u.reason}`)
  }

  const { disabled, failed } = apply(verdict, fix)
  const residual = residualProblems({ verdict, fix, disabled })
  if (residual > 0) {
    if (verdict.disableTargets.length > 0 && !fix) {
      console.log('  fix: node local/check-actions-enablement.mjs --fix')
    }
    if (verdict.overTriggered.length > 0 || verdict.stale.length > 0) {
      console.log(
        '  a file listed as allowed-inert has become a real lane, or no longer exists: ' +
          'decide whether it belongs on the live list, and record it in LOCAL-PATCHES.md § local(ci)'
      )
    }
    for (const path of failed) {
      console.log(`  STILL    ${path} could not be disabled`)
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
    triggers: readTriggers(ALLOWED_INERT, ROOT)
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
