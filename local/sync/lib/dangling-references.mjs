// Post-merge dangling-reference sweep for the lines the FORK added.
//
// This is the half of `--rename-forecast` that never existed. Before a merge the forecast answers "what
// will upstream's renames break"; after it, nothing looked again — `resolveSpecifier` returns null for an
// unresolved import and the orphan sweep is report-only, so a renamed or extracted target simply stopped
// being found. `pnpm tc` catches the TypeScript imports; a `vi.mock('…')` target, a dynamic import in a
// `.mjs` file and a path string are outside it.
//
// A module specifier (`import`, `require`, dynamic import, a mock call) that names nothing at HEAD fails
// the check. A plain string that looks like a path is reported and does not fail: a fixture that creates
// `./create.sh` at run time is indistinguishable from a broken reference, and a check nobody can make
// green is a check that gets waived every sync.

import { danglingReferences } from './orphan-sweep.mjs'
import { addedLines, referencesIn } from './rename-forecast.mjs'
import { STATUS, changedNames, git, gitText, splitNul, tailText } from './run.mjs'
import { BACKUP_REF, foreignTipFailure, pinnedUpstreamBase } from './sync-range.mjs'

const SOURCE_FILE = /\.[cm]?[jt]sx?$/
// One argv entry per scanned file overflows ARG_MAX on a wide sync, so the pathspec goes in batches.
const PATHSPEC_BATCH = 200
const MODULE_KINDS = new Set(['import', 'mock'])

const unresolved = (tip, pinned) =>
  `no merge base between ${tip.slice(0, 10)} and the pinned base ${pinned.slice(0, 10)}`

export function danglingForkReferences(tip, source, problem = null) {
  if (problem !== null) {
    return foreignTipFailure(
      problem,
      'the scan would compare the wrong range and report clean, so it refuses instead'
    )
  }
  if (!tip) {
    return {
      status: STATUS.unavailable,
      summary: `no pre-sync tip: ${BACKUP_REF} is absent and no state file names one`,
      details: ['the fork-added lines can only be read against a tip, so this is not a pass']
    }
  }
  const pinned = pinnedUpstreamBase(tip, source)
  if (pinned.base === null) {
    return {
      status: STATUS.failed,
      summary: `cannot pin the upstream base: ${pinned.problem}`,
      details: []
    }
  }
  const oldBase = gitText(['merge-base', tip, pinned.base])
  if (!oldBase) {
    return { status: STATUS.failed, summary: unresolved(tip, pinned.base), details: [] }
  }
  // Only the files the FORK touched are scanned: upstream rewrites its own callers, so scanning its whole
  // delta would read tens of thousands of files to answer a question about the fork.
  const forkTouched = changedNames(['--no-renames', '--diff-filter=AM', oldBase, tip])
  if (forkTouched === null) {
    return {
      status: STATUS.failed,
      summary: `git diff --name-only ${oldBase.slice(0, 10)}..${tip.slice(0, 10)} failed`,
      details: ['the fork-touched set is unknown, so the scan cannot report clean']
    }
  }
  const known = new Set(splitNul(gitText(['ls-tree', '-r', '--name-only', '-z', 'HEAD'])))
  const scanned = forkTouched.filter((file) => known.has(file) && SOURCE_FILE.test(file))
  if (scanned.length === 0) {
    return {
      status: STATUS.passed,
      summary: 'no fork-touched source file survived to HEAD, so there is no reference to check',
      details: []
    }
  }
  const scanFailures = []
  const linesByFile = new Map()
  for (let index = 0; index < scanned.length; index += PATHSPEC_BATCH) {
    const batch = scanned.slice(index, index + PATHSPEC_BATCH)
    const diff = git([
      'diff',
      '-U0',
      '--no-color',
      '--no-renames',
      '--diff-filter=AM',
      oldBase,
      'HEAD',
      '--',
      ...batch
    ])
    if (!diff.ok) {
      scanFailures.push(
        `git diff for ${batch.length} path(s) exited ${diff.code ?? 'without running'} — ${tailText(diff.stderr, 2).join(' ')}`
      )
      continue
    }
    for (const [file, lines] of addedLines(diff.stdout)) {
      linesByFile.set(file, lines)
    }
  }
  const references = []
  for (const [file, lines] of linesByFile) {
    const text = gitText(['show', `HEAD:${file}`])
    if (text === null) {
      scanFailures.push(`${file}: git show HEAD:${file} failed`)
      continue
    }
    for (const reference of referencesIn(file, text, lines)) {
      references.push({ file, ...reference })
    }
  }
  const seen = new Set()
  const findings = []
  const reported = []
  for (const reference of danglingReferences({ references, known })) {
    const key = `${reference.file}\u0000${reference.spec}\u0000${reference.kind}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    const line = `${reference.file}:${reference.line}  ${reference.kind} '${reference.spec}'`
    if (MODULE_KINDS.has(reference.kind)) {
      findings.push(`  ! ${line}`)
    } else {
      reported.push(`  ? ${line}`)
    }
  }
  const details = [
    `old base ${oldBase.slice(0, 10)}, pre-sync tip ${tip.slice(0, 10)}, scanned at HEAD`,
    `${scanned.length} fork-touched source file(s); ${linesByFile.size} changed since the old base`,
    `${references.length} fork-added reference(s) scanned; bare specifiers are packages and are not resolved`,
    `module specifiers naming nothing at HEAD: ${findings.length}; path strings: ${reported.length} (reported, not failed)`,
    ...reported
  ]
  if (scanFailures.length > 0) {
    return {
      status: STATUS.failed,
      summary: `the reference scan could not run for ${scanFailures.length} path(s)`,
      details: [...scanFailures.map((line) => `  ! ${line}`), ...details]
    }
  }
  return {
    status: findings.length === 0 ? STATUS.passed : STATUS.failed,
    summary:
      findings.length === 0
        ? `clear scan: every fork-added module specifier resolves at HEAD (${references.length} scanned)`
        : `${findings.length} fork-added module specifier(s) name no file at HEAD`,
    details: findings.length === 0 ? details : [...findings, ...details]
  }
}
