// Linux parity for the Mac-known-red allowlist, judged from the nightly's shard reports: every
// entry in `local/unit-known-red.json` claims its test is red *because of this Mac*, and this is
// the check that turns each claim into evidence by asking the Linux shard reports (the nightly's
// five uploads of `ci-shards/unit-report.json`) whether the test actually passed there.
//
// Pure over data the caller already holds — parsed reports and parsed allowlist — so the fixture
// tests in `linux-parity.test.mjs` run without CI access. `local/check-nightly-linux-parity.mjs`
// owns reading files and exiting.
//
// Fields this depends on, all Vitest's jest-shaped JSON reporter, the same ones
// `local/check-unit-shard-verdict.mjs` and `local/unit-gate-judgement.mjs` read:
//   testResults[].name                      — the file's path; matched to an allowlist entry as a
//                                             `/`-bounded suffix, because a Linux report names
//                                             /home/runner/work/…, not this checkout's paths
//   testResults[].status                    — 'passed'/'failed'; a 'failed' file with no failing
//                                             assertion is a collect/import error and never a pass
//   testResults[].message                   — suite-level failure text, quoted in the reason
//   assertionResults[].fullName | .title    — the test name an entry is keyed by
//   assertionResults[].status               — 'passed' is the only pass; 'failed' fails parity;
//                                             'skipped'/'pending'/unknown is absent, i.e. not a run
//   assertionResults[].failureMessages      — quoted for a failed row
//   numTotalTests                           — a zero count makes the report prove nothing
// When any of these is missing the check fails closed: structural gaps become problems, and an
// entry the reports cannot account for is `absent`, which exits non-zero — never a silent pass.

import { allowlistEntries } from '../unit-gate-judgement.mjs'

const PASSED = 'passed'
const FAILED = 'failed'
const ABSENT = 'absent'

function firstLine(message) {
  const line = String(message ?? '')
    .split('\n')[0]
    .trim()
  return line.length > 200 ? `${line.slice(0, 200)}…` : line
}

const normalisePath = (name) => String(name ?? '').replaceAll('\\', '/')

function mergeFileStatus(current, next) {
  if (current === FAILED || next === FAILED) {
    return FAILED
  }
  return current ?? next
}

/** Index parsed shard reports into one repo-relative file map. */
export function indexShardReports(reports) {
  const files = new Map()
  const problems = []
  for (const { source, report } of reports) {
    if (!report || typeof report !== 'object' || !Array.isArray(report.testResults)) {
      problems.push(
        `${source}: no testResults array, so this report proves nothing about any entry`
      )
      continue
    }
    if (!(Number(report.numTotalTests) > 0)) {
      problems.push(`${source}: the report holds no tests, so it proves nothing about any entry`)
    }
    for (const file of report.testResults) {
      const path = normalisePath(file?.name)
      if (!path) {
        problems.push(`${source}: a test result has no name, so its tests cannot be attributed`)
        continue
      }
      const seen = files.get(path) ?? { status: null, message: '', assertions: [] }
      seen.status = mergeFileStatus(seen.status, file.status ?? null)
      seen.message = seen.message || firstLine(file.message)
      for (const assertion of file.assertionResults ?? []) {
        seen.assertions.push({
          test: String(assertion.fullName || assertion.title || '(unnamed)'),
          status: String(assertion.status ?? 'unknown'),
          detail: firstLine(assertion.failureMessages)
        })
      }
      files.set(path, seen)
    }
  }
  return { files, problems }
}

/** Report paths whose `/`-bounded suffix is `file`, so `ba/x.test.ts` never matches `a/x.test.ts`. */
export function reportPathsFor(files, file) {
  return [...files.keys()].filter((path) => path === file || path.endsWith(`/${file}`))
}

/**
 * One allowlisted entry against the indexed reports. Any failing occurrence fails parity even when
 * another shard's node version passed the same test; a pass in one report waives an absence in
 * another. The entry's `match` regex is deliberately ignored: it scopes which *Mac* failures the
 * allowlist absorbs, and on Linux the question is only whether the named test passed.
 */
export function judgeParityEntry(entry, index) {
  const paths = reportPathsFor(index.files, entry.file)
  if (paths.length === 0) {
    return {
      key: entry.key,
      file: entry.file,
      test: entry.test,
      class: entry.class,
      status: ABSENT,
      detail: `no shard report collected ${entry.file} — the file did not run in any shard, which is not a pass`
    }
  }

  if (entry.test === null) {
    const failedFile = paths.find((path) => index.files.get(path).status === FAILED)
    if (failedFile) {
      return {
        key: entry.key,
        file: entry.file,
        test: null,
        class: entry.class,
        status: FAILED,
        detail: `${failedFile}: ${index.files.get(failedFile).message || 'the file failed at suite level'}`
      }
    }
    // Why a passed assertion is required rather than the file status: Vitest reports a file whose
    // every test was skipped as `passed`, so the status alone would let a whole-file entry pass parity
    // on Linux having run nothing. No entry uses the whole-file form today; this keeps the invariant
    // true when one does.
    const passedAssertion = paths.some((path) =>
      index.files.get(path).assertions.some((assertion) => assertion.status === PASSED)
    )
    if (passedAssertion) {
      return {
        key: entry.key,
        file: entry.file,
        test: null,
        class: entry.class,
        status: PASSED,
        detail: ''
      }
    }
    return {
      key: entry.key,
      file: entry.file,
      test: null,
      class: entry.class,
      status: ABSENT,
      detail: `${entry.file} appears in a shard report but reports no passing test, so nothing on Linux ran`
    }
  }

  const occurrences = paths.flatMap((path) =>
    index.files
      .get(path)
      .assertions.filter((assertion) => assertion.test === entry.test)
      .map((assertion) => ({ ...assertion, path }))
  )
  const failure = occurrences.find((assertion) => assertion.status === FAILED)
  if (failure) {
    return {
      key: entry.key,
      file: entry.file,
      test: entry.test,
      class: entry.class,
      status: FAILED,
      detail: `${failure.path}: ${failure.detail || 'no failure message'}`
    }
  }
  if (occurrences.some((assertion) => assertion.status === PASSED)) {
    return {
      key: entry.key,
      file: entry.file,
      test: entry.test,
      class: entry.class,
      status: PASSED,
      detail: ''
    }
  }
  if (occurrences.length > 0) {
    const statuses = [...new Set(occurrences.map((assertion) => assertion.status))].join(', ')
    return {
      key: entry.key,
      file: entry.file,
      test: entry.test,
      class: entry.class,
      status: ABSENT,
      detail: `${entry.file} reported this test as ${statuses} (e.g. a failing beforeAll), so it did not run — not a pass`
    }
  }
  const suiteFailure = paths.find((path) => index.files.get(path).status === FAILED)
  if (suiteFailure) {
    return {
      key: entry.key,
      file: entry.file,
      test: entry.test,
      class: entry.class,
      status: ABSENT,
      detail: `${suiteFailure} failed at suite level (collect/import error), so no test under it ran — not a pass`
    }
  }
  return {
    key: entry.key,
    file: entry.file,
    test: entry.test,
    class: entry.class,
    status: ABSENT,
    detail: `${entry.file} ran in ${paths.length} shard report(s) but never reported this test (renamed or filtered out) — not a pass`
  }
}

/**
 * Every allowlisted entry judged. `prunedSince` entries are judged too but reported separately and
 * never enforced: they were pruned for passing on the Mac, so their Linux outcome is information
 * for the next prune, not a claim this check may fail.
 */
export function judgeParity(manifest, index) {
  const rows = allowlistEntries(manifest).map((entry) => judgeParityEntry(entry, index))
  const prunedRows = allowlistEntries({ entries: manifest.prunedSince ?? [] }).map((entry) =>
    judgeParityEntry(entry, index)
  )
  const counts = { passed: 0, failed: 0, absent: 0 }
  for (const row of rows) {
    counts[row.status] += 1
  }
  return {
    rows,
    pruned: prunedRows,
    counts,
    total: rows.length,
    problems: index.problems,
    ok: rows.every((row) => row.status === PASSED) && index.problems.length === 0
  }
}

/** Human-readable lines for the verdict; the CLI prints these and adds nothing to the decision. */
export function formatParity(result, { allowlistPath, reportCount }) {
  const lines = [
    `nightly Linux parity: ${result.total} entr${result.total === 1 ? 'y' : 'ies'} from ${allowlistPath} against ${reportCount} shard report(s)`
  ]
  for (const row of result.rows) {
    if (row.status === PASSED) {
      lines.push(`  passed    ${row.key}`)
    } else if (row.status === FAILED) {
      lines.push(`  FAILED    ${row.key} — ${row.detail}`)
    } else {
      lines.push(`  ABSENT    ${row.key} — ${row.detail}`)
    }
  }
  for (const row of result.pruned.filter((r) => r.status !== PASSED)) {
    lines.push(
      `  pruned, ${row.status === FAILED ? 'FAILED' : 'ABSENT'} on Linux (not enforced): ${row.key} — ${row.detail}`
    )
  }
  const prunedCounts = { passed: 0, failed: 0, absent: 0 }
  for (const row of result.pruned) {
    prunedCounts[row.status] += 1
  }
  lines.push(
    `prunedSince (reported, not enforced): ${result.pruned.length} entr${result.pruned.length === 1 ? 'y' : 'ies'} — ` +
      `${prunedCounts.passed} passed, ${prunedCounts.failed} failed, ${prunedCounts.absent} absent on Linux`
  )
  for (const problem of result.problems) {
    lines.push(`  problem: ${problem}`)
  }
  const { passed, failed, absent } = result.counts
  lines.push(
    result.ok
      ? `parity: PASS — all ${result.total} Mac-allowlisted entries passed on Linux`
      : `parity: FAIL — ${failed} failed and ${absent} absent of ${result.total} Mac-allowlisted ` +
          `entries on Linux (${passed} passed); a failed entry is a real bug or a red that is not ` +
          `Mac-bound, an absent entry is a claim no shard report can back`
  )
  return lines
}

/** A red-set entry matches a failure when the file matches by `/`-bounded suffix and the name is in it. */
function entryMatchesFailure(entry, failure) {
  const sameFile = failure.file === entry.file || failure.file.endsWith(`/${entry.file}`)
  return sameFile && failure.test.includes(entry.test)
}

/**
 * The complement of `judgeParity`. Parity asks whether this Mac's red set holds on Linux; this asks
 * whether anything else is red there, against `local/nightly-linux-known-red.json`. Without it a
 * nightly is red forever on one upstream race, which teaches everyone to ignore red.
 *
 * Fails closed: an entry with no `evidence` is a problem, and a red that no entry matches is
 * `unexpected` and fails the verdict. A listed test that passed is `stale` — reported, never enforced,
 * because that is the signal to prune the entry rather than a reason to fail the night.
 */
export function judgeLinuxFailures(manifest, index) {
  const problems = [...index.problems]
  const entries = Array.isArray(manifest?.entries) ? manifest.entries : null
  if (entries === null) {
    problems.push('the Linux red set has no `entries` array')
  }
  for (const entry of entries ?? []) {
    if (typeof entry.file !== 'string' || entry.file === '') {
      problems.push('a Linux red-set entry has no `file`')
    }
    if (typeof entry.test !== 'string' || entry.test === '') {
      problems.push(`${entry.file}: a Linux red-set entry has no test name`)
    }
    if (typeof entry.evidence !== 'string' || entry.evidence === '') {
      problems.push(`${entry.file}: a Linux red-set entry claims a red with no evidence`)
    }
  }
  const failures = []
  for (const [path, file] of index.files) {
    for (const assertion of file.assertions) {
      if (assertion.status === 'failed') {
        failures.push({ file: path, test: assertion.test, detail: assertion.detail })
      }
    }
    // A file that failed without a failing assertion is a beforeAll/import failure: no row to match,
    // so it can never be allowlisted by name and always reads as unexpected.
    if (file.status === 'failed' && !file.assertions.some((a) => a.status === 'failed')) {
      failures.push({ file: path, test: '(file-level failure)', detail: file.message })
    }
  }
  const allowlisted = []
  const unexpected = []
  for (const failure of failures) {
    const entry = (entries ?? []).find((candidate) => entryMatchesFailure(candidate, failure))
    if (entry) {
      allowlisted.push({ ...failure, class: entry.class ?? 'unclassified' })
    } else {
      unexpected.push(failure)
    }
  }
  const stale = (entries ?? []).filter(
    (entry) => !failures.some((failure) => entryMatchesFailure(entry, failure))
  )
  return {
    allowlisted,
    unexpected,
    stale,
    failureCount: failures.length,
    total: (entries ?? []).length,
    problems,
    ok: unexpected.length === 0 && problems.length === 0
  }
}

/** Human-readable lines for the Linux red-set verdict. */
export function formatLinuxFailures(result, { allowlistPath, reportCount }) {
  const lines = [
    `nightly Linux red set: ${result.total} entr${result.total === 1 ? 'y' : 'ies'} from ${allowlistPath} against ${reportCount} shard report(s)`,
    `failing assertions on Linux: ${result.failureCount}`
  ]
  for (const row of result.allowlisted) {
    lines.push(`  known     ${row.test} — ${row.file.split('/src/').pop()} [${row.class}]`)
  }
  for (const row of result.unexpected) {
    lines.push(
      `  UNEXPECTED ${row.test} — ${row.file.split('/src/').pop()}${row.detail ? ` — ${row.detail}` : ''}`
    )
  }
  for (const entry of result.stale) {
    lines.push(
      `  prunable  ${entry.test} — ${entry.file} did not fail on Linux, so this entry can go`
    )
  }
  for (const problem of result.problems) {
    lines.push(`  problem: ${problem}`)
  }
  lines.push(
    result.ok
      ? `red set: PASS — every Linux failure is a listed one (${result.allowlisted.length} known, 0 unexpected)`
      : `red set: FAIL — ${result.unexpected.length} red(s) no entry accounts for; either it is a real ` +
          `regression or it needs an entry with evidence`
  )
  return lines
}
