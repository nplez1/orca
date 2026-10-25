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
 */
import { execFileSync } from 'node:child_process'

const REPO = 'nplez1/orca'

// Must stay enabled: the release build, the daily v* tag mirror, and the nightly full unit suite.
const REQUIRED = [
  '.github/workflows/fork-release.yml',
  '.github/workflows/fork-upstream-tags.yml',
  // Why the unit lane is required and not merely allowed: `AGENTS.md` moved the full unit suite off
  // the PR boundary and onto this nightly lane, so with it disabled nothing verifies `nplez1/main`
  // between merges — a cross-cutting break sits on the release line until someone runs the release
  // gate by hand. Treating "disabled" as drift is the whole point: this is the backstop, and a
  // backstop nobody notices is off is not one. ~50 billed minutes a night (5 shards bill at once) is
  // the accepted cost; see LOCAL-PATCHES.md § local(ci) before changing it.
  '.github/workflows/fork-main-tests.yml'
]

// Inert without a manual dispatch or a caller — active is fine, disabled is also fine.
const ALLOWED_INERT = [
  '.github/workflows/zcode-account-contract.yml',
  '.github/workflows/unit-module-cache-benchmark.yml',
  '.github/workflows/windows-native-preparation-benchmark.yml',
  '.github/workflows/ci-cache-warmup-platform-jobs.yml',
  '.github/workflows/qualified-orcad-template.yml',
  '.github/workflows/layout-owner-e2e.yml',
  '.github/workflows/dev-channel-win-publish.yml'
]

const ALLOWED = new Set([...REQUIRED, ...ALLOWED_INERT])
const fix = process.argv.includes('--fix')

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8' })
}

let workflows
try {
  workflows = JSON.parse(gh(['api', `repos/${REPO}/actions/workflows?per_page=100`])).workflows
} catch (error) {
  console.error(`check-actions: gh api failed: ${error.message}`)
  process.exit(2)
}

const drift = workflows.filter((w) => w.state === 'active' && !ALLOWED.has(w.path))
const missing = []
for (const path of REQUIRED) {
  const w = workflows.find((x) => x.path === path)
  if (!w || w.state !== 'active') {
    missing.push({ path, state: w ? w.state : 'absent' })
  }
}

const activeCount = workflows.filter((w) => w.state === 'active').length
console.log(
  `check-actions: ${workflows.length} workflows on ${REPO}, ${activeCount} active ` +
    `(${REQUIRED.length} required + ${ALLOWED_INERT.length} allowed-inert)`
)

for (const w of drift) {
  console.log(`  DRIFT    active but not on the fork's live list: ${w.path} — ${w.name}`)
}
for (const m of missing) {
  console.log(`  MISSING  required but ${m.state}: ${m.path}`)
}

let failed = false
if (fix && drift.length > 0) {
  for (const w of drift) {
    try {
      gh(['workflow', 'disable', String(w.id), '--repo', REPO])
      console.log(`  disabled ${w.path}`)
    } catch (error) {
      failed = true
      console.error(`  FAILED   could not disable ${w.path}: ${error.message}`)
    }
  }
}

if (missing.length > 0 || failed || (drift.length > 0 && !fix)) {
  if (drift.length > 0 && !fix) {
    console.log('  fix: node local/check-actions-enablement.mjs --fix')
  }
  process.exit(1)
}
console.log('  OK')
