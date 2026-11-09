// The verdict's judgement, kept apart from the process that produces a report to judge: every
// function here is pure over data the gate already holds, which is what makes it testable without
// a suite run. `local/gate-unit.mjs` runs the suite; this file decides what its report means.

// The matcher and the report walker moved to `local/lib/known-red.mjs` (#317): four judges used to
// own their own copy and they drifted, so every caller now shares one rule. The exports below stay
// here because this module is where the gate's judgement has always been imported from.
import {
  collectCases,
  judgeEntries,
  judgeUnhandled,
  normaliseEntries,
  repoPath
} from './lib/known-red.mjs'

export { collectCases, judgeUnhandled, repoPath }

/**
 * Why a `match` regex: an allowlisted test can start failing for a different reason, and matching on
 * the name alone then keeps calling that new failure known. `lint-gate` already works this way.
 */
export function judge(entries, failures, passes) {
  return judgeEntries(entries, failures, passes)
}

/** Entries are file-level (`*` or absent) unless they name a test. */
export function allowlistEntries(manifest) {
  return normaliseEntries(manifest).entries
}

/**
 * Whether a re-run's report says the file itself passed, so no failure in it may be waived.
 */
export const NO_RERUN = Object.freeze({
  complete: false,
  failures: new Set(),
  failureDetails: new Map(),
  passes: new Set(),
  filePassed: false
})

/**
 * What one file's report says about that file: its failing tests, its passing tests, and whether the
 * file itself passed. Filtered by path because a positional selector is a substring match, so
 * `thing.test.ts` also collects `thing.test.tsx`.
 */
export function reportForFile(report, file) {
  const cases = collectCases(report ?? {})
  const own = cases.failures.filter((failure) => failure.file === file)
  return {
    complete: true,
    failures: new Set(own.map((failure) => failure.test)),
    // Why the text as well as the name: an entry pins a cause, so a re-run whose allowlisted test failed
    // for a new one is not a re-run the allowlist covers.
    failureDetails: new Map(own.map((failure) => [failure.test, failure.detail])),
    passes: new Set(cases.passes.filter((pass) => pass.file === file).map((pass) => pass.test)),
    filePassed: (report?.testResults ?? []).some(
      (entry) => repoPath(entry.name) === file && entry.status === 'passed'
    )
  }
}

/**
 * Each re-run file's own reading of one shared batched report. A file the report never mentions gets
 * `NO_RERUN` — a missing report is not evidence of anything — and every named file keeps the exact-
 * path filtering a serial re-run had, so batching costs no attribution.
 */
export function rerunReportsFor(report, files) {
  const mentioned = new Set((report?.testResults ?? []).map((file) => repoPath(file.name)))
  return new Map(
    files.map((file) => [file, mentioned.has(file) ? reportForFile(report, file) : NO_RERUN])
  )
}

/**
 * Which of a file's unexpected failures survived its isolated re-run, and so are real.
 *
 * Why "did it pass" rather than "did it fail again": a test the re-run never reported is not
 * evidence, and it is the common shape — a collect error replaces every case with one `(suite)`
 * entry, a failing `beforeAll` reports its cases as skipped. Only a pass waives a failure, and a
 * pass does not waive one the same report also failed or a hook broke under.
 */
export function reproducedFailures(
  failures,
  rerun,
  { known = new Set(), covered = null, fileCovered = false } = {}
) {
  if (!rerun.complete) {
    return failures
  }
  return failures.filter((failure) => {
    if (failure.test === '(suite)') {
      // Why not `filePassed`: a file that holds an allowlisted always-red test fails in isolation too,
      // so that would make a one-off teardown error unwaivable for ever.
      if (rerun.failures.has('(suite)')) {
        return true
      }
      // Why the re-run's other failures as well: the suite row replaces the named cases in the full
      // run, so a test that only appears in isolation was never judged against the allowlist. Waiving
      // the row would pass a real red nobody read. A file-level entry covers every case, so there the
      // named failures are known and the row alone is what is being waived.
      // Why `covered` when the caller has entries: a name in `known` may have failed for a cause its
      // entry does not describe, and waiving the row would pass that red unread.
      const allowlisted = (test) =>
        covered === null ? known.has(test) : covered(test, rerun.failureDetails?.get(test))
      return fileCovered ? false : [...rerun.failures].some((test) => !allowlisted(test))
    }
    return (
      !rerun.passes.has(failure.test) ||
      rerun.failures.has(failure.test) ||
      rerun.failures.has('(suite)')
    )
  })
}

/**
 * Entries the manifest may drop. Only a complete, unfiltered run can say an entry matches nothing,
 * and a file whose only report entry is a `(suite)` failure never reported the cases under it.
 */
export function prunableEntries(unseen, report, { full, complete }) {
  if (!full || !complete) {
    return []
  }
  const suiteOnly = new Set()
  for (const file of report?.testResults ?? []) {
    if ((file.assertionResults ?? []).length === 0) {
      suiteOnly.add(repoPath(file.name))
    }
  }
  return unseen.filter((entry) => !suiteOnly.has(entry.file))
}

/** An entry for a file the gate never runs can never match, which is the same rot as a stale one. */
export function quarantinedEntryProblems(entries, quarantined) {
  const set = quarantined instanceof Set ? quarantined : new Set(quarantined)
  return entries
    .filter((entry) => set.has(entry.file))
    .map((entry) => `allowlist entry for a file the gate does not run (UNIT_EXCLUDE): ${entry.key}`)
}

/** Files the report collected although `UNIT_EXCLUDE` drops them: the exclusion did not apply. */
export function collectedQuarantinedFiles(report, quarantined) {
  const set = quarantined instanceof Set ? quarantined : new Set(quarantined)
  return (report?.testResults ?? [])
    .map((file) => repoPath(file.name))
    .filter((file) => set.has(file))
}

// What Vitest substitutes into an `it.each` title: printf tokens (including a literal `%%`), `$name`
// off a table row, and a template literal's own interpolations.
const SUBSTITUTION = /(%[$#%sdifjoOp]|\$\{[^}]*\}|\$[A-Za-z_][\w.]*)/
const MODIFIERS_WITH_ARGUMENTS = new Set(['each', 'for', 'runIf', 'skipIf'])
// Why the suffix: the repo also names its case tables `itRunsUnixShell.each(...)`, `testEach(...)`.
const TITLE_CALLER = /\b(?:describe|it|test|suite)[\w$]*/g
const NEVER_RUNS = new Set(['skip', 'todo'])
const RELATIVE_SPECIFIER = /(['"`])((?:\.{1,2}\/)[^'"`\n]*)\1/g

/**
 * The relative modules a test file pulls its cases in from, so a title can be found where it is
 * written rather than only in the file the entry names: `orca-runtime.test.ts` does `await
 * import('./orca-runtime-tests/x.spec')`. Callers read those files; this function stays pure.
 */
export function importedCaseSpecifiers(source) {
  return [
    ...new Set(
      [...source.matchAll(RELATIVE_SPECIFIER)]
        .map((match) => match[2])
        .filter((specifier) => specifier.includes('.spec'))
    )
  ]
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A source title as a pattern: the parts Vitest fills in become wildcards. */
function titlePattern(text) {
  return text
    .split(SUBSTITUTION)
    .map((part, index) => (index % 2 === 1 ? '[\\s\\S]*?' : escapeRegExp(part)))
    .join('')
}

function skipSpace(source, index) {
  while (index < source.length && /\s/.test(source[index])) {
    index++
  }
  return index
}

function closeOf(source, open) {
  let depth = 0
  for (let index = open; index < source.length; index++) {
    const char = source[index]
    if (char === '(') {
      depth++
    } else if (char === ')') {
      depth--
      if (depth === 0) {
        return index
      }
    }
  }
  return -1
}

function readLiteral(source, index) {
  const quote = source[index]
  if (quote !== "'" && quote !== '"' && quote !== '`') {
    return null
  }
  let text = ''
  for (let scan = index + 1; scan < source.length; scan++) {
    const char = source[scan]
    if (char === '\\') {
      text += source[scan + 1] ?? ''
      scan++
    } else if (char === quote) {
      return { text, end: scan + 1 }
    } else {
      text += char
    }
  }
  return null
}

/** The title strings the file gives a `describe` and each test, in source order. */
function collectTitles(source) {
  const describes = []
  const tests = []
  for (const caller of source.matchAll(TITLE_CALLER)) {
    let index = skipSpace(source, caller.index + caller[0].length)
    let runs = true
    while (source[index] === '.') {
      index = skipSpace(source, index + 1)
      const name = /^[\w$]+/.exec(source.slice(index))?.[0] ?? ''
      index = skipSpace(source, index + name.length)
      // Why: a skipped or todo case never fails, so its title cannot be a known red.
      if (NEVER_RUNS.has(name)) {
        runs = false
      }
      if (source[index] === '<') {
        const end = source.indexOf('>', index)
        index = skipSpace(source, end === -1 ? index : end + 1)
      }
      // Why: `it.concurrent(` takes no arguments of its own, `.each(table)(` does.
      if (MODIFIERS_WITH_ARGUMENTS.has(name) && source[index] === '(') {
        const close = closeOf(source, index)
        index = skipSpace(source, close === -1 ? index : close + 1)
      }
    }
    if (!runs || source[index] !== '(') {
      continue
    }
    const literal = readLiteral(source, skipSpace(source, index + 1))
    if (literal) {
      ;(caller[0].startsWith('describe') ? describes : tests).push(literal.text)
    }
  }
  return { describes, tests }
}

/**
 * Whether the file can still produce `title` as a Vitest full name, which is its `describe` chain and
 * its own title joined by single spaces.
 *
 * Why this exists: `gate-unit.mjs` derives staleness only from entries that matched a failure, so an
 * entry whose test was deleted is structurally invisible — it sits in the manifest for ever, and the
 * run that would disprove it costs 25 minutes. A static check catches the same rot at PR time.
 *
 * It over-approximates on purpose: the cost of a false "still there" is that rot hides until the next
 * full run, while the cost of a false "dead" is a live entry deleted. `source` may therefore be the
 * file plus the `.spec` modules it imports, and two shapes still count as present when they are not:
 * a title surviving only in a comment, and one behind a callee the scan cannot resolve, such as
 * `(cond ? it : it.skip)('title')`.
 */
export function titleExistsInSource(title, source) {
  const { describes, tests } = collectTitles(source)
  const chain = describes.length > 0 ? `(?:${describes.map(titlePattern).join('|')}) ` : null
  return tests.some((text) => {
    const own = titlePattern(text)
    if (new RegExp(`^${own}$`).test(title)) {
      return true
    }
    // Why 1..4: describe blocks nest, and a deeper chain is the only shape left to allow.
    return chain !== null && new RegExp(`^(?:${chain}){1,4}${own}$`).test(title)
  })
}

/**
 * Vitest exits non-zero for a failing test, so its status alone proves nothing — it proves something
 * only when nothing else explains it. Same rule as `decideUnitShardVerdict`, which explains a failed
 * shard with the known reds it absorbed, the tolerated teardown race, or a real failure.
 *
 * Why the failure count still counts, though #210 G2 asked to stop accepting it: a full run on this
 * machine always ends non-zero, because 17 allowlisted tests are red here (AGENTS.md's own sample
 * verdict line says "11 failed, all in unit-known-red.json"). Accepting only *unexpected* failures
 * therefore fails every gate run, which is not a gate — it is an outage. What G2 was describing is a
 * report that does not describe the run at all, and that is what the missing-file check above is for:
 * a crash or a narrowed include leaves files out of the report, which now fails by name.
 */
export function unexplainedSuiteExit({ outcome, status, failedCount, unhandledCount }) {
  if (outcome !== 'complete') {
    return `the suite did not run to completion: ${outcome}`
  }
  if (status === 0 || failedCount > 0 || unhandledCount > 0) {
    return null
  }
  return `the suite exited ${status === null ? 'without a status' : status} and neither the report nor the log explains it; failing closed`
}

/**
 * Files the run was supposed to collect and the report never mentions.
 *
 * Why: the report is the whole evidence base, so a narrowed include, a project that silently dropped
 * out or a worker that died between files leaves a report over whatever ran — which reads green. The
 * missing set is printed, so the failure names the files instead of "something is off".
 */
export function missingReportedFiles(report, expected) {
  const reported = new Set((report?.testResults ?? []).map((file) => repoPath(file.name)))
  return [...expected].filter((file) => !reported.has(file)).sort()
}

/** The problem a missing file set is, worded once so the gate and its test say the same thing. */
export function reportFileSetProblem(report, expected, limit = 12) {
  const missing = missingReportedFiles(report, expected)
  if (missing.length === 0) {
    return null
  }
  const more = missing.length > limit ? ` …and ${missing.length - limit} more` : ''
  return `the report does not name ${missing.length} file(s) the lane should have run: ${missing.slice(0, limit).join(', ')}${more}`
}

/** Vitest prints its own count; a mismatch means the log shape moved, so the verdict fails closed. */
export function declaredUnhandledMismatch(declaredCount, readableCount) {
  if (declaredCount === null || declaredCount === readableCount) {
    return null
  }
  return `Vitest declared ${declaredCount} unhandled error(s) but ${readableCount} could be read; failing closed`
}
