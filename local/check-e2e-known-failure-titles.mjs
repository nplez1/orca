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
 *          [--selected PATH]
 *         (OUTCOME is the run step's `outcome`: success or failure; PATH is the shard's
 *         `ci-shards/selected.txt`, which is what makes a spec that never ran a failure)
 */
import { readFileSync } from 'node:fs'
import {
  entryMatchProblems,
  failureDetail,
  judgeEntries,
  normaliseEntries
} from './lib/known-red.mjs'

const FAILED_STATUSES = new Set(['failed', 'timedOut', 'interrupted'])
/** How many unstarted specs the verdict names before summarising the rest. */
const NOT_RUN_LIMIT = 8
/** `file › describe › … › title`, stable across the line shifts an upstream edit causes. */
export function specKey(spec, suiteTitlePath) {
  const file = String(spec.file).replaceAll('\\', '/')
  // Why the shared normaliser: `selected.txt` names `x.spec.ts` relative to `tests/e2e/`, and the two
  // sides of the expected-spec check have to build the same key or a spec in a subdirectory reads as
  // both "never ran" and "not selected".
  const fileKey = e2eFileKey(file)
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
        // Why the shared helper: Playwright's error text carries SGR colour codes, and a `match`
        // regex is written against the readable line.
        return failureDetail(message)
      }
    }
  }
  return (spec.tests ?? []).map((test) => test.status).join(', ') || 'no result recorded'
}

/**
 * Whether every test of a spec was declared skipped, which is the only shape that explains a spec with
 * no result. A `test.skip()` inside a body still produces a `skipped` result, so it is not this.
 */
function declaredSkip(spec) {
  const tests = spec.tests ?? []
  return tests.length > 0 && tests.every((test) => test.expectedStatus === 'skipped')
}

export function collectOutcomes(report) {
  const failures = new Map()
  const passed = new Set()
  const seen = new Set()
  const executed = new Set()
  const notRun = new Set()
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
      if (statuses.length > 0) {
        executed.add(key)
      }
      if (specFailed(spec)) {
        failures.set(key, errorExcerpt(spec))
      } else if (statuses.includes('passed')) {
        passed.add(key)
      } else if (statuses.length === 0 && !declaredSkip(spec)) {
        // Why this is the hole #317 names: a spec that produced no result at all was expected to run
        // and did not — the shape a Playwright run interrupted partway leaves behind. A spec whose
        // every test is declared `test.skip()` is a legitimate skip and is not listed here.
        notRun.add(key)
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
    executed,
    notRun,
    aliasToKey,
    globalErrors: (report.errors ?? []).map((error) => String(error.message ?? error))
  }
}

/**
 * `file › describe › … › title` split at the first separator: a spec key is a file plus the rest, and a
 * file path never contains ` › `.
 */
export function splitKey(key) {
  const at = key.indexOf(' › ')
  return at === -1 ? { file: key, test: '' } : { file: key.slice(0, at), test: key.slice(at + 3) }
}

/**
 * What the recorded titles mean against this report, through the same matcher the unit manifests use:
 * identity is the spec key, and the cause is the entry's `match` tested against the error excerpt.
 */
export function judge(known, outcomes) {
  // Why the alias is resolved on the entry rather than the failure: a title copied out of a CI log
  // names the step the test died in, and the failure is keyed by the spec that owns it.
  const entries = [...known].map(([key, entry]) => ({
    ...entry,
    ...splitKey(outcomes.aliasToKey.get(key) ?? key),
    key
  }))
  const failures = [...outcomes.failures].map(([key, detail]) => ({ ...splitKey(key), detail }))
  const passes = [...outcomes.passed].map((key) => splitKey(key))
  const judged = judgeEntries(entries, failures, passes)
  const ownerOf = (failure) => `${failure.file} › ${failure.test}`
  const knownByKey = new Map()
  for (const { failure, entry } of judged.known) {
    knownByKey.set(ownerOf(failure), known.get(entry.key) ?? entry)
  }
  return {
    knownByKey,
    unexpected: judged.unexpected.map((failure) => [ownerOf(failure), failure.detail]),
    quarantined: judged.known.map(({ failure }) => [ownerOf(failure), failure.detail]),
    stale: judged.stale.map((entry) => entry.key),
    drifted: judged.drifted.map(({ failure, entry }) => [ownerOf(failure), failure.detail, entry])
  }
}

/**
 * The manifest's titles as entries, keyed the way a spec key is spelled.
 *
 * Why the raw title is spread back over the normalised one: `normaliseEntries` keeps a fixed shape, and
 * the notice line this verdict prints quotes `observedForkRuns`/`observedUpstreamRuns` as the evidence
 * for the entry — the fields that say how often it has been seen. Dropping them prints `undefined`.
 */
export function titleKeys(manifest) {
  const titles = manifest.titles ?? []
  const { entries } = normaliseEntries(titles.map((title) => ({ ...title, test: title.title })))
  return new Map(entries.map((entry, index) => [entry.key, { ...titles[index], ...entry }]))
}

/** A spec file as the report and `selected.txt` both spell it. */
export function e2eFileKey(file) {
  const normalised = String(file ?? '')
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
  if (normalised.startsWith('tests/e2e/')) {
    return normalised
  }
  return normalised.startsWith('e2e/') ? `tests/${normalised}` : `tests/e2e/${normalised}`
}

/**
 * The specs a shard was told to run, from `ci-shards/selected.txt` — the file the workflow hands
 * Playwright as `--test-list`, so it is the same selection the report should describe.
 */
export function selectedFiles(text) {
  return new Set(
    String(text)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map(e2eFileKey)
  )
}

/**
 * Whether the report describes the selection.
 *
 * Why this is not "every selected spec must run": 179 of this repo's 587 e2e spec files call
 * `test.skip`, and a platform-conditional skip is legitimate. The shapes that are not are a selected
 * file the report never mentions, a spec that produced no result at all while none of its tests
 * declared a skip — which is what an interrupted run leaves behind, and what let a run with one known
 * failure pass after a timeout — and a spec from a file the selection does not name.
 */
export function expectedSpecProblems({ selected, outcomes }) {
  if (selected === null) {
    return []
  }
  const problems = []
  const files = new Set()
  for (const key of outcomes.seen) {
    files.add(splitKey(key).file)
  }
  // Why only "absent": a file whose specs are all declared skips legitimately produces no result on
  // this platform, and the per-spec rule below already catches a spec that was expected to run.
  for (const file of selected) {
    if (!files.has(file)) {
      problems.push(
        `selected spec file never ran: ${file} — the shard was assigned it and the report holds no spec from it`
      )
    }
  }
  // Why the cap: an interrupted shard leaves one row per unstarted spec, and a wall of them buries the
  // failure list above it.
  const notRun = [...outcomes.notRun]
  for (const key of notRun.slice(0, NOT_RUN_LIMIT)) {
    problems.push(
      `selected spec never ran: ${key} — it produced no result and none of its tests declared a skip`
    )
  }
  if (notRun.length > NOT_RUN_LIMIT) {
    problems.push(`and ${notRun.length - NOT_RUN_LIMIT} more selected spec(s) that never ran`)
  }
  for (const file of files) {
    if (!selected.has(file)) {
      problems.push(
        `the report names specs from a file this shard was not selected to run: ${file} — selected.txt does not describe this run`
      )
    }
  }
  return problems
}

/**
 * The verdict, apart from printing and exiting, so the exit composition is testable.
 *
 * Why the outcome and the spec count: no unexpected failure and no `report.errors` used to be enough
 * to pass, which accepted a zero-spec report and a Playwright exit that no spec explained. Both are
 * the shape of a run that proved nothing, so both fail closed.
 */
export function decideE2eVerdict({ known, outcomes, outcome, selected = null }) {
  const problems = []
  if (outcomes.seen.size === 0) {
    problems.push('the report holds no specs, so the run cannot be judged green')
  }
  if (outcome !== 'success' && outcome !== 'failure') {
    problems.push(`unknown test-step outcome "${outcome}"`)
  }
  const judged = judge(known, outcomes)
  // Why the manifest is judged here too: a title with no `match` and no `flaky: true` absorbs any
  // failure of that spec, which is the looseness #317 is about.
  problems.push(...entryMatchProblems([...known.values()]))
  for (const message of outcomes.globalErrors) {
    problems.push(`the report carried a global error: ${String(message).split('\n')[0]}`)
  }
  for (const [key, detail] of judged.unexpected) {
    problems.push(
      `unexpected E2E failure (not in e2e-known-failure-titles.json): ${key} — ${detail}`
    )
  }
  for (const [key, detail, entry] of judged.drifted) {
    problems.push(
      `listed spec failed for a new cause: ${key} — ${detail}, which its entry's match ${JSON.stringify(entry.matchSource)} does not describe`
    )
  }
  problems.push(...expectedSpecProblems({ selected, outcomes }))
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

function parseArgs(argv) {
  const positional = []
  let selectedPath = null
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--selected') {
      // Why a missing value is a usage error rather than "no flag": the caller asked for the selection
      // to be judged, and silently judging nothing is the hole the flag exists to close.
      if (argv[index + 1] === undefined) {
        console.error('usage: --selected needs a path')
        process.exit(2)
      }
      selectedPath = argv[(index += 1)]
    } else {
      positional.push(argv[index])
    }
  }
  return { positional, selectedPath }
}

function main() {
  const { positional, selectedPath } = parseArgs(process.argv.slice(2))
  const [reportPath, titlesPath, outcome] = positional
  if (!reportPath || !titlesPath || outcome === undefined) {
    console.error(
      'usage: check-e2e-known-failure-titles.mjs REPORT.json TITLES.json OUTCOME (success|failure)' +
        ' [--selected PATH]'
    )
    process.exit(2)
  }
  const known = titleKeys(readJson(titlesPath))
  const outcomes = collectOutcomes(readJson(reportPath))
  // Why a named path that cannot be read is fatal while an absent flag is not: the workflow passes it,
  // and a shard that was told what to run cannot be judged green without it.
  let selected = null
  if (selectedPath !== null) {
    try {
      selected = selectedFiles(readFileSync(selectedPath, 'utf8'))
    } catch (error) {
      console.error(`cannot read the selection at ${selectedPath}: ${error.message}`)
      process.exit(1)
    }
    if (selected.size === 0) {
      console.error(
        `the selection at ${selectedPath} names no spec file, so nothing proves what this shard should have run`
      )
      process.exit(1)
    }
  }
  const verdict = decideE2eVerdict({ known, outcomes, outcome, selected })
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
