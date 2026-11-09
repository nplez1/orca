// One known-red matcher for every manifest this fork keeps.
//
// Four judges used to decide what a listed red covers, and they drifted: the nightly red set ignored
// the entry's `match` and accepted any test name that merely *ended* with the entry's title, while the
// gate honoured `match` and the e2e judge had no notion of a cause at all. A new failure in an
// allowlisted test was therefore absorbed by two of the four. This module is the single rule they all
// call:
//
//   1. the file matches by `/`-bounded suffix — a report names `/home/runner/work/orca/orca/src/a.ts`
//      while a manifest names `src/a.ts`, and `ba/x.test.ts` must never pair with `a/x.test.ts`;
//   2. the test name matches **exactly** — Vitest reports the full name, describe chain included, so
//      that is what an entry stores. The old suffix match existed to spare manifest authors the
//      describe prefix, and it is what let one entry absorb every sibling whose title happened to end
//      the same way;
//   3. the entry's `match` regex matches the failure's first line, once ANSI is stripped and a leading
//      `Error: ` removed.
//
// An entry with no `match` absorbs any failure of its test, which is the looseness this issue is
// about, so `entryMatchProblems` reports every such entry that is not `flaky: true`. `flaky` used to be
// a display label; it is now the declared exemption from pinning a cause, which is why an intermittent
// title whose failure text was never captured can still be listed honestly.
//
// Pure over data the callers already hold: no file reads, no process state, so the fixture tests run
// without a suite, a runner or CI.

import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..', '..')

/** The marker `collectCases` uses for a file that failed outside any of its cases. */
export const SUITE_FAILURE = '(suite)'

// Why the limit: a failure message's first line is a headline, and a manifest regex is written against
// it. A `$`-anchored pattern longer than the cap can therefore never match — which fails closed.
const DETAIL_LIMIT = 200
// Why not the shared stripAnsiEscapeSequences helper: that one is TypeScript, and CI runs these
// scripts under plain node. Reporters colour with SGR codes only, so `ESC[…m` is the whole alphabet.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

/**
 * A failure's headline, which is what a `match` regex is tested against.
 *
 * Why the `Error: ` strip: it is the reporter's prefix rather than part of the cause, so every entry
 * would otherwise have to spell it. A `TimeoutError:` or `DaemonConnectionLostError:` prefix is part of
 * the cause and is kept.
 */
export function failureDetail(message) {
  // Why the first element: `assertionResults[].failureMessages` is an array, and `String([a, b])` joins
  // it with a comma — which breaks a `$`-anchored `match` on the first message.
  const text = Array.isArray(message) ? (message[0] ?? '') : (message ?? '')
  const line = String(text)
    .replace(ANSI, '')
    .replace(/^Error:\s*/, '')
    .split('\n')[0]
    .trim()
  return line.length > DETAIL_LIMIT ? `${line.slice(0, DETAIL_LIMIT)}…` : line
}

/**
 * An entry's `match` source as a regex.
 *
 * Why a problem rather than a throw: an invalid regex must not become an entry that silently never
 * matches, and a named problem reaches the verdict summary where a stack trace does not.
 */
export function compileMatch(source) {
  if (source === undefined || source === null) {
    return { regex: null, problem: null }
  }
  try {
    return { regex: new RegExp(String(source)), problem: null }
  } catch (error) {
    return { regex: null, problem: `unusable match ${JSON.stringify(source)}: ${error.message}` }
  }
}

/** A repo-relative path, because Vitest reports absolute names on the machine that ran the suite. */
export function repoPath(name) {
  // Why both sides: Vitest reports forward-slash names even on Windows, where ROOT is backslashed.
  // Why the separator: `…/issue-151-x` must not read as inside `…/issue-151`.
  const root = `${ROOT.replaceAll('\\', '/').replace(/\/$/, '')}/`
  const normalised = String(name ?? '').replaceAll('\\', '/')
  return normalised.startsWith(root) ? normalised.slice(root.length) : normalised
}

/**
 * A manifest entry as the judges use it. `test: null` is the file-level form (`*`, absent or null —
 * `String(null)` would otherwise make the entry a case named "null"), and `wholeStep` is the lint
 * gate's form for a step whose output the parser cannot split.
 *
 * Why `matchProblem` rather than a throw: an invalid regex must not become an entry that silently never
 * matches, and a named problem reaches the verdict summary where a stack trace does not.
 */
export function normaliseEntries(manifest) {
  const declared = Array.isArray(manifest) ? manifest : (manifest?.entries ?? [])
  const problems = []
  const entries = (Array.isArray(declared) ? declared : []).map((entry) => {
    const file = String(entry?.file ?? '').replaceAll('\\', '/')
    const test =
      entry?.test === undefined || entry?.test === null || entry?.test === '*'
        ? null
        : String(entry.test)
    const key = test === null ? `${file} › *` : `${file} › ${test}`
    // Why not pushed into `problems` here: `entryMatchProblems` is the one reporter, so a caller that
    // runs both does not print the same problem twice.
    const compiled = compileMatch(entry?.match)
    const match = compiled.regex
    const matchProblem = compiled.problem === null ? null : `${key}: ${compiled.problem}`
    return {
      file,
      test,
      class: String(entry?.class ?? 'unclassified'),
      owner: String(entry?.owner ?? 'unattributed'),
      flaky: entry?.flaky === true,
      wholeStep: entry?.wholeStep === true,
      match,
      matchSource: entry?.match ?? null,
      matchProblem,
      key
    }
  })
  return { entries, problems }
}

/**
 * Why the path separator: a report carries `/home/runner/.../src/a.ts`, the manifest `src/a.ts`, and the
 * prefix differs per machine — so the suffix is the only pairing available without knowing where the
 * report ran. The residual cost is that a nested copy of the same relative path would pair too; the
 * gate normalises its own paths with `repoPath` first, so that only bites a report from another checkout
 * that also contains a `src/a.ts` below its root.
 */
export function entryFileMatches(entry, reportPath) {
  const path = String(reportPath ?? '').replaceAll('\\', '/')
  return path === entry.file || path.endsWith(`/${entry.file}`)
}

/**
 * Whether an entry is about this test at all, ignoring the cause. Staleness and prunability are
 * questions of identity — a test that passed has to be reported prunable even when its entry pins a
 * cause, or the entry can never be retired.
 */
export function entryIdentifiesTest(entry, { file, test }) {
  if (!entryFileMatches(entry, file)) {
    return false
  }
  // A whole-file entry is about anything in that file; a named entry never covers a failure that
  // happened outside any test, which is a red the entry cannot account for.
  if (entry.test === null) {
    return true
  }
  return entry.test === test
}

/**
 * Whether an entry absorbs this failure: identity plus the cause, so an allowlisted test that starts
 * failing for a new reason is not silently known.
 */
export function entryMatchesFailure(entry, failure) {
  if (!entryIdentifiesTest(entry, failure)) {
    return false
  }
  // Why a broken regex absorbs nothing: the entry named a cause it cannot test, so the honest reading
  // is "unknown", and the verdict already reports the entry as a problem. Treating it as match-less
  // would absorb every failure of that test — the looseness this module exists to remove.
  if (entry.matchProblem !== null && entry.matchProblem !== undefined) {
    return false
  }
  return entry.match === null || entry.match.test(String(failure.detail ?? ''))
}

/**
 * Every entry that cannot pin a cause. `allowNoMatch` is how the lint gate keeps its whole-step form,
 * which is the one entry shape with nothing to match against.
 */
export function entryMatchProblems(entries, { allowNoMatch = () => false } = {}) {
  const problems = []
  for (const entry of entries) {
    if (entry.matchProblem) {
      problems.push(entry.matchProblem)
    } else if (entry.match === null && !entry.flaky && !allowNoMatch(entry)) {
      problems.push(
        `known-red entry has no match and is not flaky: ${entry.key} — a new failure in this test would be absorbed as known`
      )
    }
  }
  return problems
}

/**
 * Vitest's JSON reporter is jest-shaped: one entry per file in `testResults`, one per case in
 * `assertionResults`. A file can fail without a failing assertion (collect/import error, a teardown
 * error beside passing cases), so that is recorded as a `(suite)` failure rather than being lost —
 * and a named entry must never absorb it.
 */
export function collectCases(report) {
  const failures = []
  const passes = []
  for (const file of report?.testResults ?? []) {
    const path = repoPath(file.name)
    let sawFailedCase = false
    for (const assertion of file.assertionResults ?? []) {
      const test = String(assertion.fullName || assertion.title || '(unnamed)')
      if (assertion.status === 'failed') {
        sawFailedCase = true
        failures.push({ file: path, test, detail: failureDetail(assertion.failureMessages) })
      } else if (assertion.status === 'passed') {
        passes.push({ file: path, test })
      }
    }
    // Why the message on its own: an afterAll or teardown error is not the failure a named entry
    // accounts for, so absorbing the row must not absorb this red beside it.
    if (file.status === 'failed' && (file.message || !sawFailedCase)) {
      failures.push({
        file: path,
        test: SUITE_FAILURE,
        detail: failureDetail(file.message) || 'the file failed without a failing case'
      })
    }
  }
  return { failures, passes }
}

/**
 * What a set of failures means against a set of entries.
 *
 * `drifted` is the bucket the two-way match makes necessary: an entry whose test failed for a cause its
 * `match` does not describe. It is unexpected — the verdict must fail — but it is *not* `unseen`, which
 * a full run reports as prunable, because the test is still red and the entry is still doing work.
 */
export function judgeEntries(entries, failures, passes) {
  const known = []
  const unexpected = []
  const drifted = []
  for (const failure of failures) {
    const entry = entries.find((candidate) => entryMatchesFailure(candidate, failure))
    if (entry) {
      known.push({ failure, entry })
      continue
    }
    unexpected.push(failure)
    const identified = entries.find((candidate) => entryIdentifiesTest(candidate, failure))
    if (identified) {
      drifted.push({ failure, entry: identified })
    }
  }
  // Why the drifted entries count as matched: their test is red, so calling the entry unseen would
  // invite pruning a live entry.
  const matched = new Set([...known, ...drifted].map((item) => item.entry.key))
  // Why the failure set is consulted: a file-level entry matches one failing case while other cases in
  // the same file pass, which must not read as "this entry is stale".
  const stale = entries.filter(
    (entry) => !matched.has(entry.key) && passes.some((pass) => entryIdentifiesTest(entry, pass))
  )
  // Why not "the file did not fail": with a named entry, a renamed or deleted case is unmatched and not
  // stale while its file still reds elsewhere — the entry has gone dead, and nothing else says so.
  const staleKeys = new Set(stale.map((entry) => entry.key))
  const unseen = entries.filter((entry) => !matched.has(entry.key) && !staleKeys.has(entry.key))
  return { known, unexpected, drifted, stale, unseen }
}

/**
 * `unhandledErrors` entries are claims about the run, not about one test, so they pin a cause by
 * `match` (a headline can carry a machine-specific path) or by an exact `headline`.
 */
export function normaliseUnhandled(manifest) {
  const declared = Array.isArray(manifest) ? manifest : (manifest?.unhandledErrors ?? [])
  const problems = []
  const entries = (Array.isArray(declared) ? declared : []).map((entry) => {
    const headline = entry?.headline === undefined ? null : String(entry.headline)
    const compiled = compileMatch(entry?.match)
    const match = compiled.regex
    let matchProblem = compiled.problem
    if (matchProblem !== null) {
      problems.push(matchProblem)
    } else if (match === null && headline === null) {
      matchProblem =
        'an unhandledErrors entry has neither a match nor a headline, so it can never be judged'
      problems.push(matchProblem)
    }
    return { ...entry, headline, match, matchProblem }
  })
  return { entries, problems }
}

export function unhandledEntryMatches(entry, headline) {
  // Why nothing matches when the entry named a cause it cannot test: the same rule the test entries
  // follow, so an unusable regex never becomes a broad absorber.
  if (entry.matchProblem) {
    return false
  }
  if (entry.match !== null && entry.match !== undefined) {
    return entry.match.test(headline)
  }
  return (
    entry.headline !== null && entry.headline !== undefined && String(entry.headline) === headline
  )
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
    const entry = declared.find((candidate) => unhandledEntryMatches(candidate, headline))
    if (entry) {
      known.push({ ...entry, headline, count })
    } else {
      blocking.push({ headline, count })
    }
  }
  return { known, blocking }
}
