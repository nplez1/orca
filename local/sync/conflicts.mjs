#!/usr/bin/env node
// Triage for a fork sync stop: which files conflict, what shape each hunk is, and what this fork
// already decided about that path. It replaces the throwaway script (three stages, two delimiter
// balances, classify by eye) that every upstream sync re-wrote about twenty times.
//
// ADVISORY ONLY. Delimiter balance is a counter that does not strip strings or comments, the
// added/removed counts are multiset differences, and the member/rename checks are heuristics: a class
// describes the shape of a conflict, it is not the resolution. `local/sync/convergence-ledger.md` is
// the binding record, and it is read, never written.
//
//   node local/sync/conflicts.mjs [--summary | --json | --verify]
//   node local/sync/conflicts.mjs --merge-tree <base> <other>
//   node local/sync/conflicts.mjs --help

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import {
  classifyFile,
  ledgerMatches,
  ledgerResolution,
  parseLedger
} from './lib/conflict-classify.mjs'
import {
  deletionFor,
  parseExpectedDeletions,
  pendingDeletionPaths,
  staleDeletions
} from './lib/expected-deletions.mjs'
import { proposeAll } from './lib/conflict-propose.mjs'
import { classCounts, renderSummary, renderText } from './lib/conflict-report.mjs'

const LEDGER_URL = new URL('./convergence-ledger.md', import.meta.url)
const DELETIONS_URL = new URL('./expected-deletions.json', import.meta.url)
const UNMERGED = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])
// Labelled markers only: a bare `=======` line is a diff separator in .patch files and a rule in
// licence text, both of which this repo tracks.
const MARKER_PATTERN = '^(<<<<<<<|\\|\\|\\|\\|\\|\\|\\|) |^>>>>>>> '
const MESSAGE = /^(Auto-merging|CONFLICT|Warning:|fatal:|error:|Failed to merge)/
const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/

const HELP = `conflict triage for an upstream sync stop — advisory only

usage
  node local/sync/conflicts.mjs                             live state: rebase, merge, cherry-pick
  node local/sync/conflicts.mjs --summary                   counts by class, one line per file
  node local/sync/conflicts.mjs --json                      machine-readable, for other tools
  node local/sync/conflicts.mjs --verify                    exit 1 if conflict markers remain
  node local/sync/conflicts.mjs --propose                   what the fork has already decided, per path
  node local/sync/conflicts.mjs --apply                     resolve those, stage them, commit nothing
  node local/sync/conflicts.mjs --merge-tree <base> <other> what that merge would conflict on
  node local/sync/conflicts.mjs --help

--summary and --json compose with --merge-tree and --propose; --verify runs alone and --apply needs
the worktree.

--propose prints only what the fork has settled twice over: a \`Resolution:\` verb in the ledger, or a
settled entry in \`expected-deletions.json\`. A verb is a whole-file decision, so a hunk-level one (the
Identity entry) is recorded as \`manual\` and proposes nothing. --apply runs the git steps and stages
them; it never commits, and it refuses to act on a \`--merge-tree\` run because there is no index.

classes, each a hint and never a resolution; a class describes the shape and names the question it
leaves open — the report never says which side to keep
  union              both sides balanced, added lines disjoint
  duplicate-tail     both sides opened the same expression and one or both end mid-expression at a
                     shared tail after '>>>>>>>' that closes them
  both-rewrote       same region changed on both sides, or the sides diverge before the shared tail
                     could close either: human decision, candidate bodies printed
  duplicate-members  both sides add the same member (indented key/value, x.set(key, ...), or a
                     one-per-line quoted union/list entry), so a union repeats it
  rename-replay      same line shapes, different identifiers or paths — advisory
  add/add            from AA/AU/UA; modify/delete from UD/DU; both-deleted from DD
  inconclusive       the hunk could not be classified: no class is claimed for it

Delimiter balance cannot prove a union correct and no class here is a resolution:
\`local/sync/convergence-ledger.md\` is. Every conflicted path is printed with the Decision and Do not
lines of each ledger section whose Paths glob matches it (--summary prints section titles only).

--merge-tree reconstructs the three sides from <base>, <other> and their merge base, so a side a
rename moved away reads as missing, and status codes come from the commit contents, not an index.`

// ------------------------------------------------------------------ git plumbing

const git = (args) => spawnSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })

function gitText(args, { allowFailure = false } = {}) {
  const result = git(args)
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    if (allowFailure) {
      return null
    }
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`)
  }
  return result.stdout.replace(/\n$/, '')
}

const blobAt = (ref, path) => gitText(['show', `${ref}:${path}`], { allowFailure: true })

function worktreeText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

const unmergedPaths = () =>
  (gitText(['diff', '--name-only', '--diff-filter=U', '-z']) ?? '').split('\u0000').filter(Boolean)

function unmergedStatuses() {
  const statuses = new Map()
  let extraPath = false
  for (const record of (gitText(['status', '--porcelain=v1', '-z']) ?? '').split('\u0000')) {
    if (record === '' || extraPath) {
      // A rename record is followed by its original path, which has no status code.
      extraPath = false
      continue
    }
    const code = record.slice(0, 2)
    if (UNMERGED.has(code)) {
      statuses.set(record.slice(3), code)
    }
    extraPath = code.startsWith('R') || code.startsWith('C')
  }
  return statuses
}

function readState(gitDir) {
  const info = (name) => {
    try {
      return readFileSync(join(gitDir, name), 'utf8').trim()
    } catch {
      return ''
    }
  }
  const rebase = ['rebase-merge', 'rebase-apply'].find((dir) => existsSync(join(gitDir, dir)))
  if (rebase) {
    const [step, total] = rebase === 'rebase-merge' ? ['msgnum', 'end'] : ['next', 'last']
    return {
      kind: 'rebase',
      step: Number(info(`${rebase}/${step}`) || 0),
      total: Number(info(`${rebase}/${total}`) || 0),
      branch: info(`${rebase}/head-name`).replace('refs/heads/', ''),
      onto: info(`${rebase}/onto`).slice(0, 10)
    }
  }
  for (const [file, kind] of [
    ['MERGE_HEAD', 'merge'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
    ['REVERT_HEAD', 'revert']
  ]) {
    if (existsSync(join(gitDir, file))) {
      const head = info(file).split('\n')[0].trim().slice(0, 10)
      return { kind, head, subject: info('MERGE_MSG').split('\n')[0] }
    }
  }
  return { kind: 'none' }
}

// ------------------------------------------------------------------ adapters

function readLive() {
  const statuses = unmergedStatuses()
  const files = [...new Set([...statuses.keys(), ...unmergedPaths()])].map((path) =>
    classifyFile({
      path,
      status: statuses.get(path) ?? null,
      base: blobAt(':1', path),
      ours: blobAt(':2', path),
      theirs: blobAt(':3', path),
      merged: worktreeText(path)
    })
  )
  return { mode: 'live', state: readState(gitText(['rev-parse', '--git-dir'])), files, notes: [] }
}

function readMergeTree(base, other) {
  const notes = []
  let result = git(['merge-tree', '--write-tree', '--name-only', '--no-messages', base, other])
  if (result.error) {
    throw result.error
  }
  if (!OID.test((result.stdout.split('\n')[0] ?? '').trim()) && /no-messages/.test(result.stderr)) {
    // An older Git rejects --no-messages and writes nothing to stdout; its informational messages are
    // then appended after a blank line on the same stream, so the sections are split deliberately
    // rather than with `tail -n +2`.
    notes.push('git has no --no-messages: the blank line separated the messages from the path list')
    result = git(['merge-tree', '--write-tree', '--name-only', base, other])
  }
  const rows = result.stdout.split('\n')
  const tree = (rows[0] ?? '').trim()
  if (!OID.test(tree)) {
    throw new Error(
      `unexpected git merge-tree output: ${(result.stdout || result.stderr).trim().slice(0, 200)}`
    )
  }
  const paths = []
  for (const row of rows.slice(1)) {
    if (row === '') {
      break // informational messages start here — they are not conflicted paths
    }
    if (!MESSAGE.test(row)) {
      paths.push(unquoted(row))
    }
  }
  if (result.status !== 0 && paths.length === 0 && result.stderr.trim() !== '') {
    throw new Error(`git merge-tree failed: ${result.stderr.trim()}`)
  }
  const mergeBase = gitText(['merge-base', base, other], { allowFailure: true })
  if (mergeBase === null) {
    notes.push('no merge base between the two commits — sides read as absent')
  }
  const files = paths.map((path) => {
    const ours = blobAt(base, path)
    const theirs = blobAt(other, path)
    const baseContent = mergeBase === null ? null : blobAt(mergeBase, path)
    const deleted =
      ours === null && theirs === null ? 'DD' : ours === null ? 'DU' : theirs === null ? 'UD' : null
    return classifyFile({
      path,
      status: deleted ?? (baseContent === null ? 'AA' : null),
      base: baseContent,
      ours,
      theirs,
      merged: blobAt(tree, path)
    })
  })
  if (files.some((file) => file.status !== null)) {
    notes.push('status codes come from the commit contents here, not from an index')
  }
  return {
    mode: 'merge-tree',
    state: { kind: 'merge-tree', base, other, tree, mergeBase, clean: paths.length === 0 },
    files,
    notes
  }
}

// Git quotes paths it cannot print plainly (core.quotePath); JSON unescaping covers every case
// except its octal form for non-UTF8 bytes, which falls through to the raw text.
function unquoted(path) {
  if (!path.startsWith('"')) {
    return path
  }
  try {
    return JSON.parse(path)
  } catch {
    return path
  }
}

// ------------------------------------------------------------------ ledger

function loadLedger() {
  if (!existsSync(LEDGER_URL)) {
    return {
      found: false,
      sections: [],
      note: `no ledger at ${LEDGER_URL.pathname} — decisions unavailable`
    }
  }
  try {
    const sections = parseLedger(readFileSync(LEDGER_URL, 'utf8'))
    const orphans = sections
      .filter((section) => section.paths.length === 0)
      .map((section) => section.title)
    // Why: an unrecognised Resolution verb is a ledger defect, not "no instruction".
    const badResolutions = sections
      .map((section) => ({ section, resolution: ledgerResolution(section) }))
      .filter(({ resolution }) => resolution?.action === 'unknown')
      .map(({ section, resolution }) => `${section.title} (${resolution.verb})`)
    const problems = []
    if (orphans.length > 0) {
      problems.push(`ledger section(s) with no Paths, check by hand: ${orphans.join('; ')}`)
    }
    if (badResolutions.length > 0) {
      problems.push(`ledger Resolution verb(s) not in the fixed set: ${badResolutions.join('; ')}`)
    }
    return {
      found: true,
      sections,
      note: problems.length === 0 ? null : problems.join(' | ')
    }
  } catch (error) {
    return {
      found: false,
      sections: [],
      note: `ledger unreadable (${error.message}) — decisions unavailable`
    }
  }
}

function attachLedger(files, ledger) {
  for (const file of files) {
    file.ledger = ledgerMatches(ledger.sections, file.path).map((section) => ({
      title: section.title,
      decision: section.decision,
      doNot: section.doNot,
      resolution: ledgerResolution(section)
    }))
  }
}

function attachExpectedDeletions(files, manifest) {
  for (const file of files) {
    file.expectedDeletion = deletionFor(manifest.entries, file.path)
  }
}

/**
 * The manifest answers "who deleted this, and was that the answer?" for a modify/delete conflict.
 * Checked against HEAD on read, because a manifest that still calls a restored file deleted would talk a
 * resolver into deleting it again — the stale paths are named in the note, and the note now reaches the
 * text report as well as `--json`, so a human sees them without asking for JSON. The note does not stop
 * `--apply`: a stale entry is a manifest to fix, not a resolution to trust.
 */
function loadExpectedDeletions() {
  let text
  try {
    text = readFileSync(DELETIONS_URL, 'utf8')
  } catch {
    return { entries: [], note: `no deletion manifest at ${DELETIONS_URL.pathname}` }
  }
  const { entries, note } = parseExpectedDeletions(text)
  const atHead = new Set(
    (gitText(['ls-tree', '-r', '--name-only', 'HEAD']) ?? '').split('\n').filter(Boolean)
  )
  const stale = staleDeletions(entries, atHead)
  const problems = [note]
  if (stale.length > 0) {
    problems.push(`manifest calls deleted but HEAD still has: ${stale.join('; ')}`)
  }
  return { entries, note: problems.filter(Boolean).join(' | ') || null }
}

/** Runs each proposal's git steps. Never commits: resolving the index is the point, not finishing. */
function applyProposals(proposals) {
  const failures = []
  let applied = 0
  for (const proposal of proposals) {
    let ok = true
    for (const args of proposal.git) {
      const result = git(args)
      if (result.status !== 0) {
        const first = (result.stderr ?? '').trim().split('\n')[0]
        failures.push(`${proposal.path}: git ${args.join(' ')} — ${first}`)
        ok = false
        break
      }
    }
    if (ok) {
      applied += 1
    }
  }
  return { applied, failures }
}

// ------------------------------------------------------------------ rendering

// ------------------------------------------------------------------ verify

// A scan that could not run is never a clean tree: the operator has to see the command's own error.
function verifyFailed(what, stderr, maxLines = 10) {
  console.log(`verify: FAIL — ${what}`)
  const lines = String(stderr ?? '')
    .trimEnd()
    .split('\n')
    .filter((line) => line !== '')
  for (const line of lines.slice(0, maxLines)) {
    console.log(`  ${line}`)
  }
  if (lines.length > maxLines) {
    console.log(`  ... ${lines.length - maxLines} more line(s)`)
  }
  return 1
}

function runVerify() {
  let paths
  try {
    paths = unmergedPaths()
  } catch (error) {
    return verifyFailed(
      'the unmerged-path scan (git diff --diff-filter=U) could not run',
      error.message
    )
  }
  const grep = git(['grep', '-I', '-l', '-E', MARKER_PATTERN, '--', '.'])
  if (grep.error) {
    return verifyFailed('git grep could not be spawned', grep.error.message ?? grep.error)
  }
  // git grep exits 1 for "no match", which is the pass case; any other non-zero status is the scan
  // itself failing, and reporting that as clean would hide the files it never read.
  if (grep.status !== 0 && grep.status !== 1) {
    return verifyFailed(
      `the conflict-marker scan could not run (git grep exit ${grep.status})`,
      (grep.stderr ?? '') + (grep.stdout ?? '')
    )
  }
  const markers = (grep.stdout ?? '').split('\n').filter(Boolean)
  const rows = []
  if (paths.length > 0) {
    rows.push(`${paths.length} unmerged path(s) in the index: ${paths.join(', ')}`)
  }
  if (markers.length > 0) {
    rows.push(
      `${markers.length} worktree file(s) still contain conflict-marker lines: ${markers.join(', ')}`
    )
  }
  if (rows.length === 0) {
    console.log(
      'verify: clean — no unmerged paths, no conflict-marker lines in tracked worktree files'
    )
    return 0
  }
  console.log('verify: conflicts remain —')
  for (const row of rows) {
    console.log(`  ${row}`)
  }
  return 1
}

// ------------------------------------------------------------------ main

// The source (live state or a --merge-tree dry run) and the output format are orthogonal, so the
// sibling pre-sync tool's `--merge-tree <base> <other> --summary` works. --verify runs alone.
function parseArgs(argv) {
  const options = {
    source: 'live',
    output: 'text',
    verify: false,
    propose: false,
    apply: false,
    base: null,
    other: null
  }
  const setOutput = (name) => {
    if (options.output !== 'text' && options.output !== name) {
      throw new Error('pick one of --summary, --json')
    }
    options.output = name
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--help' || flag === '-h') {
      return { help: true }
    }
    if (flag === '--merge-tree') {
      options.source = 'merge-tree'
      options.base = argv[index + 1] ?? null
      options.other = argv[index + 2] ?? null
      index += 2
      if (options.base === null || options.other === null) {
        throw new Error('--merge-tree needs <base> <other>')
      }
      continue
    }
    if (flag === '--summary' || flag === '--json') {
      setOutput(flag.slice(2))
      continue
    }
    if (flag === '--verify') {
      options.verify = true
      continue
    }
    if (flag === '--propose') {
      options.propose = true
      continue
    }
    if (flag === '--apply') {
      options.propose = true
      options.apply = true
      continue
    }
    throw new Error(`unknown argument: ${flag}`)
  }
  if (options.verify && (options.source !== 'live' || options.output !== 'text')) {
    throw new Error('--verify runs alone: it reads the worktree, not a classification input')
  }
  if (options.apply && options.source !== 'live') {
    throw new Error('--apply needs the worktree: a --merge-tree run has no index to resolve')
  }
  return options
}

function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`conflicts: ${error.message}`)
    console.error('run `node local/sync/conflicts.mjs --help`')
    return 2
  }
  if (options.help) {
    console.log(HELP)
    return 0
  }
  try {
    if (options.verify) {
      return runVerify()
    }
    const result =
      options.source === 'merge-tree' ? readMergeTree(options.base, options.other) : readLive()
    const ledger = loadLedger()
    attachLedger(result.files, ledger)
    const manifest = loadExpectedDeletions()
    attachExpectedDeletions(result.files, manifest)
    // Why in result.notes and not only in the JSON payload: headRows renders result.notes, so a stale
    // manifest went unreported in the text and --summary reports — the two a human actually reads.
    if (manifest.note) {
      result.notes.push(`deletion manifest: ${manifest.note}`)
    }
    const pending = pendingDeletionPaths(
      manifest.entries,
      result.files.map((file) => file.path)
    )
    if (pending.length > 0) {
      result.notes.push(
        `${pending.length} conflicted path(s) are pending-decision in expected-deletions.json: ${pending.join('; ')}`
      )
    }
    if (options.propose) {
      for (const file of result.files) {
        file.proposal = null
      }
      for (const proposal of proposeAll(result.files)) {
        const file = result.files.find((candidate) => candidate.path === proposal.path)
        if (file) {
          file.proposal = proposal
        }
      }
      const settled = result.files.filter((file) => file.proposal)
      result.notes.push(
        `${settled.length} of ${result.files.length} conflicted path(s) carry a settled resolution; the rest are manual`
      )
      if (options.apply) {
        const outcome = applyProposals(settled.map((file) => file.proposal))
        result.notes.push(
          `applied ${outcome.applied} resolution(s), ${outcome.failures.length} failed — the index is staged, nothing is committed`
        )
        for (const failure of outcome.failures) {
          console.error(`conflicts: apply failed — ${failure}`)
        }
      }
    }
    if (options.output === 'json') {
      const { byClass } = classCounts(result.files)
      const payload = {
        advisory: true,
        ...result,
        counts: { paths: result.files.length, byClass },
        ledger: { path: LEDGER_URL.pathname, found: ledger.found },
        deletions: { path: DELETIONS_URL.pathname, entries: manifest.entries.length }
      }
      // Why not manifest.note again: it is already in result.notes with the `deletion manifest:` prefix.
      payload.notes = [...result.notes, ledger.note].filter(Boolean)
      console.log(JSON.stringify(payload, null, 2))
      return 0
    }
    console.log(
      options.output === 'summary' ? renderSummary(result, ledger) : renderText(result, ledger)
    )
    return 0
  } catch (error) {
    console.error(`conflicts: ${error.message}`)
    return 2
  }
}

process.exit(main())
