// The verdict's judgement, kept apart from the process that produces a report to judge: every
// function here is pure over data the gate already holds, which is what makes it testable without
// a suite run. `local/gate-unit.mjs` runs the suite; this file decides what its report means.

import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

export function repoPath(name) {
  // Why both sides: Vitest reports forward-slash names even on Windows, where ROOT is backslashed.
  // Why the separator: `…/issue-151-x` must not read as inside `…/issue-151`.
  const root = `${ROOT.replaceAll('\\', '/').replace(/\/$/, '')}/`
  const normalised = String(name ?? '').replaceAll('\\', '/')
  return normalised.startsWith(root) ? normalised.slice(root.length) : normalised
}

function firstLine(message) {
  const line = String(message ?? '')
    .replace(/^Error:\s*/, '')
    .split('\n')[0]
    .trim()
  return line.length > 200 ? `${line.slice(0, 200)}…` : line
}

/**
 * Vitest's JSON reporter is jest-shaped: one entry per file in `testResults`, one per case in
 * `assertionResults`. A file can fail without a failing assertion (collect/import error), so that
 * is recorded as a `(suite)` failure rather than being lost.
 */
export function collectCases(report) {
  const failures = []
  const passes = []
  for (const file of report.testResults ?? []) {
    const path = repoPath(file.name)
    let sawFailedCase = false
    for (const assertion of file.assertionResults ?? []) {
      const test = String(assertion.fullName || assertion.title || '(unnamed)')
      if (assertion.status === 'failed') {
        sawFailedCase = true
        failures.push({ file: path, test, detail: firstLine(assertion.failureMessages) })
      } else if (assertion.status === 'passed') {
        passes.push({ file: path, test })
      }
    }
    // Why the message on its own: an afterAll or teardown error is not the failure a named entry
    // accounts for, so absorbing the row must not absorb this red beside it — the rule
    // `check-unit-shard-verdict.mjs` already applies to a shard.
    if (file.status === 'failed' && (file.message || !sawFailedCase)) {
      failures.push({
        file: path,
        test: '(suite)',
        detail: firstLine(file.message) || 'the file failed without a failing case'
      })
    }
  }
  return { failures, passes }
}

export function judge(entries, failures, passes) {
  const known = []
  const unexpected = []
  for (const failure of failures) {
    const entry = entries.find((candidate) => entryMatchesFailure(candidate, failure))
    if (entry) {
      known.push({ failure, entry })
    } else {
      unexpected.push(failure)
    }
  }
  // Why the failure set is consulted: a file-level entry matches one failing case while other
  // cases in the same file pass, which must not read as "this entry is stale".
  const matched = new Set(known.map((item) => item.entry.key))
  const stale = entries.filter(
    (entry) =>
      !matched.has(entry.key) &&
      passes.some(
        (pass) => pass.file === entry.file && (entry.test === null || entry.test === pass.test)
      )
  )
  // Why not "the file did not fail": with a named entry, a renamed or deleted case is unmatched and
  // not stale while its file still reds elsewhere — the entry has gone dead, and nothing else says so.
  const staleKeys = new Set(stale.map((entry) => entry.key))
  const unseen = entries.filter((entry) => !matched.has(entry.key) && !staleKeys.has(entry.key))
  return { known, unexpected, stale, unseen }
}

/**
 * An unhandled error is a claim about the run, not about one test, so it is matched by headline and
 * collapsed: one suite can raise the same rejection 28 times, and 28 identical lines is noise.
 */
export function judgeUnhandled(headlines, entries) {
  const declared = Array.isArray(entries) ? entries : []
  const counts = new Map()
  for (const headline of headlines) {
    counts.set(headline, (counts.get(headline) ?? 0) + 1)
  }
  const known = []
  const blocking = []
  for (const [headline, count] of counts) {
    const entry = declared.find((candidate) => String(candidate.headline) === headline)
    if (entry) {
      known.push({ ...entry, headline, count })
    } else {
      blocking.push({ headline, count })
    }
  }
  return { known, blocking }
}

/** Entries are file-level (`*` or absent) unless they name a test. */
export function allowlistEntries(manifest) {
  const entries = Array.isArray(manifest.entries) ? manifest.entries : []
  return entries.map((entry) => {
    const file = String(entry.file).replaceAll('\\', '/')
    const test = entry.test === undefined || entry.test === '*' ? null : String(entry.test)
    return {
      file,
      test,
      class: String(entry.class ?? 'unclassified'),
      owner: String(entry.owner ?? 'unattributed'),
      flaky: entry.flaky === true,
      // Why it throws: an invalid regex must not become an entry that silently never matches.
      match: entry.match === undefined ? null : new RegExp(String(entry.match)),
      key: test === null ? `${file} › *` : `${file} › ${test}`
    }
  })
}

/**
 * Why a `match` regex: an allowlisted test can start failing for a different reason, and matching on
 * the name alone then keeps calling that new failure known. `lint-gate` already works this way.
 */
function entryMatchesFailure(entry, failure) {
  if (entry.file !== failure.file) {
    return false
  }
  if (entry.test !== null && entry.test !== failure.test) {
    return false
  }
  return entry.match === null || entry.match.test(String(failure.detail ?? ''))
}

/**
 * Whether a re-run's report says the file itself passed, so no failure in it may be waived.
 */
export const NO_RERUN = Object.freeze({
  complete: false,
  failures: new Set(),
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
  return {
    complete: true,
    failures: new Set(
      cases.failures.filter((failure) => failure.file === file).map((failure) => failure.test)
    ),
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
  { known = new Set(), fileCovered = false } = {}
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
      return fileCovered ? false : [...rerun.failures].some((test) => !known.has(test))
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
