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
    if (!sawFailedCase && file.status === 'failed') {
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
    const entry = entries.find(
      (candidate) =>
        candidate.file === failure.file &&
        (candidate.test === null || candidate.test === failure.test)
    )
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
      key: test === null ? `${file} › *` : `${file} › ${test}`
    }
  })
}

/**
 * Which of a file's unexpected failures survived its isolated re-run, and so are real.
 *
 * Why "did it pass" rather than "did it fail again": a test the re-run never reported is not
 * evidence, and it is the common shape — a collect error replaces every case with one `(suite)`
 * entry, a failing `beforeAll` reports its cases as skipped. Only a pass waives a failure.
 */
export function reproducedFailures(failures, rerun) {
  if (!rerun.complete) {
    return failures
  }
  return failures.filter((failure) =>
    failure.test === '(suite)' ? !rerun.filePassed : !rerun.passes.has(failure.test)
  )
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
