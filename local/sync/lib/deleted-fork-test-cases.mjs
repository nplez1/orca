// The case-level half of the upstream-deleted-fork-tests row: fork-added test cases that no test file at
// HEAD still carries.
//
// Why: the file-level check accepted the 2026-11-15 sync's 179 retired files under one reason, and three
// sets of fork-owned cases left with them (the release-channel repo pins, the VM-recipe trust content, the
// ephemeral-VM rollback projection). A file is the wrong grain: upstream retires a suite, the fork's cases
// in it are what the fork loses. Only the Opus release review noticed.
//
// "Fork-added" is a title in a test file the fork added or modified since the old merge base that the same
// file did not have there, and that no test file had there either (so a case the fork merely moved between
// files stays upstream's). It counts as kept when any test file at HEAD has the title, so a moved case is
// not flagged. Titles are compared as literals: a renamed case reads as a loss, which is the safe side.

import { execFileSync } from 'node:child_process'
import { STATUS, changedNames, gitText, repoRoot, splitNul } from './run.mjs'

// `it(` / `test(` with any chain of modifiers (`.only`, `.skip`, `.skipIf(isWin())`, ...), then a
// string literal. `.each` tables put the title in a second call and are not read. Not after `.` or a
// word, so `/re/.test('x')` and `xit(` are not cases.
const CASE =
  /(?<![\w.$])(?:it|test)((?:\.\w+(?:\((?:[^()]|\([^()]*\))*\))?)*)\s*\(\s*(['"`])((?:\\[\s\S]|(?!\2)[^\\])*)\2/g

/** What a reasonless init writes. It is not a reason, so it never records a case. */
export const UNRECORDED_REASON = 'recorded without a reason'

/** Whether `cases` records this one with a reason of its own. */
export function caseRecorded(cases, { file, title }) {
  const reason = cases?.[file]?.[title]
  return typeof reason === 'string' && reason !== UNRECORDED_REASON
}

/** The gone cases `cases` does not record with a reason of its own. */
export function unrecordedCases(cases, gone) {
  return gone.filter((entry) => !caseRecorded(cases, entry))
}

/** The case titles one test file declares, decoded so a quote-style change is not a rename. */
export function testTitles(source) {
  const titles = new Set()
  for (const match of source.matchAll(CASE)) {
    if (/\.each\b/.test(match[1])) {
      continue
    }
    titles.add(match[2] === '`' ? match[3] : match[3].replace(/\\(.)/g, '$1'))
  }
  return titles
}

/**
 * Pure: `tipSources` is the fork-touched test files at the pre-sync tip, `baseSources` the same paths at
 * the old base (absent = the fork added the file). `headTitles` and `baseTitles` are every title in every
 * test file at HEAD and at the old base.
 */
export function goneForkCases({ tipSources, baseSources, headTitles, baseTitles }) {
  const gone = []
  for (const [file, text] of [...tipSources].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const before = baseSources.has(file) ? testTitles(baseSources.get(file)) : new Set()
    for (const title of [...testTitles(text)].sort()) {
      if (!before.has(title) && !baseTitles.has(title) && !headTitles.has(title)) {
        gone.push({ file, title })
      }
    }
  }
  return gone
}

/** `{ path: text }` for `files` at `rev`, in one `git cat-file --batch`; a path missing there is absent. */
export function readBlobs(rev, files) {
  const sources = new Map()
  if (files.length === 0) {
    return sources
  }
  const out = execFileSync('git', ['cat-file', '--batch'], {
    cwd: repoRoot(),
    input: files.map((file) => `${rev}:${file}\n`).join(''),
    maxBuffer: 1024 * 1024 * 1024
  })
  // Sizes are bytes, so the output is walked as a Buffer and only each blob is decoded.
  let offset = 0
  for (const file of files) {
    const newline = out.indexOf(10, offset)
    const header = out.subarray(offset, newline).toString('utf8')
    offset = newline + 1
    const size = /^[0-9a-f]+ blob (\d+)$/.exec(header)
    if (size === null) {
      continue
    }
    const length = Number(size[1])
    sources.set(file, out.subarray(offset, offset + length).toString('utf8'))
    offset += length + 1
  }
  return sources
}

function titlesAt(rev, isTest) {
  const listing = gitText(['ls-tree', '-r', '--name-only', '-z', rev])
  if (listing === null) {
    return null
  }
  const titles = new Set()
  for (const text of readBlobs(rev, splitNul(listing).filter(isTest)).values()) {
    for (const title of testTitles(text)) {
      titles.add(title)
    }
  }
  return titles
}

/** The git half: `{ gone, scanned }`, or `{ problem }` when a revision cannot be read. */
export function measureGoneForkCases({ oldBase, tip, head = 'HEAD', isTest }) {
  const touched = changedNames(['--no-renames', '--diff-filter=AM', oldBase, tip])
  const headTitles = titlesAt(head, isTest)
  const baseTitles = titlesAt(oldBase, isTest)
  if (touched === null || headTitles === null || baseTitles === null) {
    return { problem: `git could not read ${oldBase.slice(0, 10)}, ${tip.slice(0, 10)} or ${head}` }
  }
  const files = touched.filter(isTest)
  const gone = goneForkCases({
    tipSources: readBlobs(tip, files),
    baseSources: readBlobs(oldBase, files),
    headTitles,
    baseTitles
  })
  return { gone, scanned: files.length }
}

/**
 * Bound to the same range as the file baseline, and for the same reason. Each entry carries its own
 * reason (`cases[file][title]`), because a dropped case is a decision about that case.
 */
export function compareDeletedForkCases({ baseline, gone, range }) {
  const bound =
    baseline !== null &&
    typeof baseline === 'object' &&
    baseline.base === range.base &&
    baseline.tip === range.tip
  const known = bound ? (baseline.cases ?? {}) : {}
  const appeared = gone.filter((entry) => !caseRecorded(known, entry))
  const present = new Set(gone.map(({ file, title }) => `${file}\0${title}`))
  const stale = Object.entries(known).flatMap(([file, titles]) =>
    Object.keys(titles ?? {})
      .filter((title) => !present.has(`${file}\0${title}`))
      .map((title) => ({ file, title }))
  )
  return { bound, appeared, stale, clean: bound && appeared.length === 0 }
}

/** The `cases` map a baseline writes: a reason already recorded for a case is kept over the new one. */ export function buildCaseBaseline(
  gone,
  { previous, accepted }
) {
  const cases = {}
  for (const { file, title } of gone) {
    cases[file] ??= {}
    cases[file][title] = caseRecorded(previous, { file, title }) ? previous[file][title] : accepted
  }
  return cases
}

// Every case, grouped by file: the saved report is where this list is read, and a cap is how the three
// sets this row exists for would have sat below the fold.
export function describeCaseComparison(comparison, { total, scanned }) {
  const byFile = new Map()
  for (const { file, title } of comparison.appeared) {
    byFile.set(file, [...(byFile.get(file) ?? []), title])
  }
  return [
    `${total} fork-added test case(s) from ${scanned} fork-touched test file(s) are in no test file at HEAD`,
    ...[...byFile].flatMap(([file, titles]) => [
      `  ! ${file} (${titles.length})`,
      ...titles.map((title) => `      ${JSON.stringify(title)}`)
    ]),
    ...(comparison.stale.length === 0
      ? []
      : [
          `  ? ${comparison.stale.length} recorded case(s) are back at HEAD — re-run --baseline-init`
        ])
  ]
}

export function caseOutcome({ oldBase, tip, baseline, range, isTest }) {
  const measured = measureGoneForkCases({ oldBase, tip, isTest })
  if (measured.problem) {
    return { status: STATUS.failed, clean: false, summary: measured.problem, details: [] }
  }
  const comparison = compareDeletedForkCases({ baseline, gone: measured.gone, range })
  return {
    status: comparison.clean ? STATUS.passed : STATUS.failed,
    clean: comparison.clean,
    gone: measured.gone,
    appeared: comparison.appeared.length,
    details: describeCaseComparison(comparison, {
      total: measured.gone.length,
      scanned: measured.scanned
    })
  }
}
