#!/usr/bin/env node
/**
 * Scheduled-lane verdict for this fork.
 *
 * A failure whose title is listed in `e2e-known-failure-titles.json` is reported but does not fail
 * the run, so the red set this fork inherits from upstream stops emailing while a new failure still
 * does. Upstream's own runs never call this: `.github/workflows/e2e.yml` guards it on
 * `github.repository` and leaves Playwright's exit code in charge there.
 *
 * The run step's outcome is an input, not a detail: the report can be empty (a Playwright that never
 * collected anything, a shard that died before writing) and a non-zero exit can have no spec behind
 * it. Both fail closed here, the way `check-unit-shard-verdict.mjs` judges a shard.
 *
 * Usage: node local/check-e2e-known-failure-titles.mjs REPORT.json TITLES.json OUTCOME
 *         (OUTCOME is the run step's `outcome`: success or failure)
 */
import { readFileSync } from 'node:fs'

const FAILED_STATUSES = new Set(['failed', 'timedOut', 'interrupted'])
const ERROR_EXCERPT_CHARS = 240
/** `file › describe › … › title`, stable across the line shifts an upstream edit causes. */
export function specKey(spec, suiteTitlePath) {
  const file = String(spec.file).replaceAll('\\', '/')
  const fileKey = file.includes('/') ? file : `tests/e2e/${file}`
  // Why: the JSON reporter's top-level suite title is the spec's own file name, so keeping it
  // would duplicate the file and never match a recorded title.
  const describes = suiteTitlePath[0] === spec.file ? suiteTitlePath.slice(1) : suiteTitlePath
  return [fileKey, ...describes, spec.title].join(' › ')
}

function collectStepKeys(steps, prefix, keys) {
  for (const step of steps ?? []) {
    const next = `${prefix} › ${step.title}`
    keys.push(next)
    collectStepKeys(step.steps, next, keys)
  }
}

function runStatuses(spec) {
  return (spec.tests ?? []).flatMap((test) => (test.results ?? []).map((result) => result.status))
}

/**
 * Why `spec.ok` first: the JSON reporter's `test.status` is an outcome category
 * (`expected`/`unexpected`/`flaky`/`skipped`), and only `results[].status` is the run status — so a
 * `test.fail()` case reports `failed` there while the suite rightly calls it expected.
 */
function specFailed(spec) {
  if (spec.ok === false) {
    return true
  }
  return (spec.tests ?? []).some((test) =>
    (test.results ?? []).some(
      (result) => FAILED_STATUSES.has(result.status) && test.expectedStatus === 'passed'
    )
  )
}

function errorExcerpt(spec) {
  for (const test of spec.tests ?? []) {
    for (const result of test.results ?? []) {
      const message = result.error?.message ?? result.errors?.[0]?.message
      if (message) {
        const firstLine = String(message).trim().split('\n')[0]
        return firstLine.length > ERROR_EXCERPT_CHARS
          ? `${firstLine.slice(0, ERROR_EXCERPT_CHARS)}…`
          : firstLine
      }
    }
  }
  return (spec.tests ?? []).map((test) => test.status).join(', ') || 'no result recorded'
}

export function collectOutcomes(report) {
  const failures = new Map()
  const passed = new Set()
  const seen = new Set()
  // Why: the list reporter appends the step a test died in to its title, so a title copied out of a
  // CI log has to resolve back to the spec that owns it or the entry would never match.
  const aliasToKey = new Map()
  const visit = (suite, ancestors) => {
    const titlePath = suite.title ? [...ancestors, suite.title] : ancestors
    for (const spec of suite.specs ?? []) {
      const key = specKey(spec, titlePath)
      seen.add(key)
      const stepKeys = []
      for (const test of spec.tests ?? []) {
        for (const result of test.results ?? []) {
          collectStepKeys(result.steps, key, stepKeys)
        }
      }
      for (const stepKey of stepKeys) {
        aliasToKey.set(stepKey, key)
      }
      const statuses = runStatuses(spec)
      if (specFailed(spec)) {
        failures.set(key, errorExcerpt(spec))
      } else if (statuses.includes('passed')) {
        passed.add(key)
      }
    }
    for (const child of suite.suites ?? []) {
      visit(child, titlePath)
    }
  }
  for (const suite of report.suites ?? []) {
    visit(suite, [])
  }
  return {
    failures,
    passed,
    seen,
    aliasToKey,
    globalErrors: (report.errors ?? []).map((error) => String(error.message ?? error))
  }
}

export function judge(known, outcomes) {
  const knownByKey = new Map()
  const stale = []
  for (const [key, entry] of known) {
    const owner = outcomes.aliasToKey.get(key) ?? key
    if (outcomes.failures.has(owner)) {
      knownByKey.set(owner, entry)
    } else if (outcomes.passed.has(owner)) {
      stale.push(key)
    }
  }
  return {
    knownByKey,
    unexpected: [...outcomes.failures].filter(([key]) => !knownByKey.has(key)),
    quarantined: [...outcomes.failures].filter(([key]) => knownByKey.has(key)),
    stale
  }
}

export function titleKeys(manifest) {
  return new Map(manifest.titles.map((entry) => [`${entry.file} › ${entry.title}`, entry]))
}

/**
 * The verdict, apart from printing and exiting, so the exit composition is testable.
 *
 * Why the outcome and the spec count: no unexpected failure and no `report.errors` used to be enough
 * to pass, which accepted a zero-spec report and a Playwright exit that no spec explained. Both are
 * the shape of a run that proved nothing, so both fail closed.
 */
export function decideE2eVerdict({ known, outcomes, outcome }) {
  const problems = []
  if (outcomes.seen.size === 0) {
    problems.push('the report holds no specs, so the run cannot be judged green')
  }
  if (outcome !== 'success' && outcome !== 'failure') {
    problems.push(`unknown test-step outcome "${outcome}"`)
  }
  const judged = judge(known, outcomes)
  for (const message of outcomes.globalErrors) {
    problems.push(`the report carried a global error: ${String(message).split('\n')[0]}`)
  }
  for (const [key, detail] of judged.unexpected) {
    problems.push(
      `unexpected E2E failure (not in e2e-known-failure-titles.json): ${key} — ${detail}`
    )
  }
  // Why: a known failure explains the non-zero exit, which is the whole point of this lane. Nothing
  // in the report explaining it is the case a green verdict used to cover.
  if (outcome === 'failure' && outcomes.failures.size === 0 && outcomes.globalErrors.length === 0) {
    problems.push('the run failed and neither the report nor a recorded failure explains it')
  }
  return { ...judged, problems, ok: problems.length === 0 }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`cannot read ${path}: ${error.message}`)
  }
}

function main() {
  const [reportPath, titlesPath, outcome] = process.argv.slice(2)
  if (!reportPath || !titlesPath || outcome === undefined) {
    console.error(
      'usage: check-e2e-known-failure-titles.mjs REPORT.json TITLES.json OUTCOME (success|failure)'
    )
    process.exit(2)
  }
  const known = titleKeys(readJson(titlesPath))
  const outcomes = collectOutcomes(readJson(reportPath))
  const verdict = decideE2eVerdict({ known, outcomes, outcome })
  const { knownByKey, unexpected, quarantined, stale } = verdict

  console.log(
    `E2E verdict (run step: ${outcome}): ${outcomes.seen.size} spec(s) in this report, ` +
      `${outcomes.failures.size} failing, ${quarantined.length} known, ${unexpected.length} unexpected, ` +
      `${stale.length} stale entry(ies) in ${titlesPath}`
  )
  for (const [key, detail] of quarantined) {
    const entry = knownByKey.get(key)
    const announce = entry.owner === 'upstream' ? 'notice' : 'warning'
    console.log(
      `::${announce}::known failure (${entry.owner}), in ${entry.observedForkRuns} fork / ` +
        `${entry.observedUpstreamRuns} upstream sampled run(s): ${key} — ${detail}`
    )
  }
  for (const key of stale) {
    // A notice, not a warning: these titles are intermittent, so passing in one shard is not a fix.
    console.log(
      `::notice::recorded failure passed in this shard (intermittent), prune only once it stops failing: ${key}`
    )
  }
  for (const problem of verdict.problems) {
    console.log(`::error::${problem}`)
  }
  if (!verdict.ok) {
    process.exit(1)
  }
}

if (process.argv[1] && process.argv[1].endsWith('check-e2e-known-failure-titles.mjs')) {
  main()
}
