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
 *   node local/check-actions-enablement.mjs --fix    disable everything that drifted
 *
 * Two things this check does beyond comparing names, because a name is not what spends the minutes:
 * it reads each allowed-inert file's `on:` keys and fails when one gained a trigger that fires
 * without a human (`schedule`, `push`, `pull_request`), and it pages through the workflow list so a
 * 101st file is not invisible. Exit codes: 0 clean, 1 drift or an unverifiable entry, 2 cannot
 * reach the API — "cannot tell" is never a pass.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse } from 'yaml'

const REPO = 'nplez1/orca'
const ROOT = resolve(import.meta.dirname, '..')

// Must stay enabled: the release build, the daily v* tag mirror, the nightly full unit suite, and
// the daily health check that watches the other three.
export const REQUIRED = [
  '.github/workflows/fork-release.yml',
  '.github/workflows/fork-upstream-tags.yml',
  // Why the unit lane is required and not merely allowed: `AGENTS.md` moved the full unit suite off
  // the PR boundary and onto this nightly lane, so with it disabled nothing verifies `nplez1/main`
  // between merges — a cross-cutting break sits on the release line until someone runs the release
  // gate by hand. Treating "disabled" as drift is the whole point: this is the backstop, and a
  // backstop nobody notices is off is not one. See LOCAL-PATCHES.md § local(ci) before changing it.
  '.github/workflows/fork-main-tests.yml',
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

/**
 * Judge enablement from already-fetched data, so the decision is testable without a network.
 * `triggers` maps a workflow path to its `on:` keys, or to `{ error }` when the file could not be
 * read from the tree — an unreadable allowed-inert entry is reported, never silently tolerated.
 */
export function judgeEnablement(
  { workflows, triggers = {} },
  { required = REQUIRED, allowedInert = ALLOWED_INERT } = {}
) {
  const allowed = new Set([...required, ...allowedInert])
  const active = workflows.filter((w) => w.state === 'active')
  const drift = active.filter((w) => !allowed.has(w.path))
  const missing = required
    .map((path) => ({ path, workflow: workflows.find((w) => w.path === path) }))
    .filter(({ workflow }) => !workflow || workflow.state !== 'active')
    .map(({ path, workflow }) => ({ path, state: workflow ? workflow.state : 'absent' }))
  const stale = allowedInert
    .filter((path) => !workflows.some((w) => w.path === path))
    .map((path) => ({ path, reason: 'no workflow file by that path on the repository' }))

  const overTriggered = []
  const unreadable = []
  for (const path of allowedInert) {
    const facts = triggers[path]
    if (facts === undefined) {
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

  const problems =
    drift.length + missing.length + stale.length + overTriggered.length + unreadable.length
  return {
    total: workflows.length,
    activeCount: active.length,
    drift,
    missing,
    stale,
    overTriggered,
    unreadable,
    ok: problems === 0
  }
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

/** Print the verdict, disabling drift under `--fix`, and return the problems that remain. */
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
  const driftErrors = []
  if (fix && verdict.drift.length > 0) {
    for (const w of verdict.drift) {
      try {
        gh(['workflow', 'disable', String(w.id), '--repo', REPO])
        console.log(`  disabled ${w.path}`)
      } catch (error) {
        driftErrors.push(w.path)
        console.error(`  FAILED   could not disable ${w.path}: ${firstLine(error)}`)
      }
    }
  }
  // A drift entry this run disabled is no longer a problem; one that failed to disable still is.
  const residualDrift = fix ? driftErrors.length : verdict.drift.length
  const residual =
    residualDrift +
    verdict.missing.length +
    verdict.stale.length +
    verdict.overTriggered.length +
    verdict.unreadable.length
  if (residual > 0) {
    if (residualDrift > 0 && !fix) {
      console.log('  fix: node local/check-actions-enablement.mjs --fix')
    }
    if (verdict.overTriggered.length > 0 || verdict.stale.length > 0) {
      console.log(
        '  a file listed as allowed-inert has become a real lane, or no longer exists: ' +
          'decide whether it belongs on the live list, and record it in LOCAL-PATCHES.md § local(ci)'
      )
    }
  }
  return residual
}

function main() {
  const fix = process.argv.includes('--fix')
  let workflows
  try {
    workflows = workflowsFromPages(
      JSON.parse(
        gh(['api', '--paginate', '--slurp', `repos/${REPO}/actions/workflows?per_page=100`])
      )
    )
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
