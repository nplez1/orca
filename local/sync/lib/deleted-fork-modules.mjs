// The deleted-module check: every fork-only module a sync deleted, with the exported surface it
// carried, and whether the live tree still references each name.
//
// Why its own module: this is the half of the post-sync report that proves a deletion was reviewed,
// and it is the largest single check. `deletedForkModules` cannot see test files on purpose — those
// are `deleted-fork-tests.mjs` — and it cannot see a modified file at all, which is `lostContent`.

import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { readDeletionManifest } from './expected-deletions.mjs'
import { BACKUP_REF, foreignTipFailure, pinnedUpstreamBase } from './sync-range.mjs'
import { STATUS, changedNames, git, gitText, repoRoot, splitNul, tailText } from './run.mjs'

// ---- deleted modules -------------------------------------------------------------------------

// Extensions a deleted file has to have to be carrying behaviour of its own. A deleted `.json`,
// `.md` or `.snap` is a removal a reviewer can see; a deleted module is where a unique side effect
// can disappear without any conflict marker or type error.
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.mjs'])
// Tests, spec files, and the fixture/mock trees are not the module a caller imports.
const NOT_A_MODULE = /(^|[.-])(test|spec)\.|[.-](test|tests|fixture|fixtures)$/
const NOT_A_MODULE_DIR = new Set(['__fixtures__', '__mocks__', '__tests__'])

// Repo-relative paths, so the posix flavour is the right one on every platform.
export function isDeletedCodeModule(file) {
  const ext = path.posix.extname(file)
  if (!CODE_EXTENSIONS.has(ext) || file.endsWith('.d.ts')) {
    return false
  }
  const segments = file.split('/')
  if (segments.some((segment) => NOT_A_MODULE_DIR.has(segment))) {
    return false
  }
  return !NOT_A_MODULE.test(segments.at(-1))
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/
// Words that follow `export` in a declaration but are never the declared name themselves.
const NOT_A_NAME = new Set([
  'abstract',
  'async',
  'class',
  'const',
  'declare',
  'default',
  'enum',
  'export',
  'extends',
  'from',
  'function',
  'implements',
  'interface',
  'let',
  'namespace',
  'type',
  'var'
])
// Ordered: `const enum` before `const`, which would otherwise record the word `enum` as the name.
const DECLARED_EXPORTS = [
  [/\bexport\s+(?:declare\s+)?const\s+enum\s+([A-Za-z_$][\w$]*)/g, 'type'],
  [
    /\bexport\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g,
    'function'
  ],
  [/\bexport\s+(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g, 'class'],
  [/\bexport\s+(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g, 'const'],
  [/\bexport\s+(?:declare\s+)?(?:type|interface|enum|namespace)\s+([A-Za-z_$][\w$]*)/g, 'type']
]
const EXPORT_CLAUSE = /\bexport\s+(?:type\s+)?\{([^}]*)\}/g
// `export default` has no name a caller could import; only a named form is searchable.
const DEFAULT_EXPORT =
  /\bexport\s+default\s+(?:async\s+)?(?:function\s*\*?\s*|class\s+)?([A-Za-z_$][\w$]*)?/g

// A parser, not a compiler: it reads the names a caller would import, so the live-tree search
// below has something to look for. It says nothing about how the module behaved.
export function exportInventory(source) {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  const found = new Map()
  const record = (name, kind) => {
    if (typeof name !== 'string' || !IDENTIFIER.test(name) || NOT_A_NAME.has(name)) {
      return
    }
    if (!found.has(name)) {
      found.set(name, kind)
    }
  }
  for (const [pattern, kind] of DECLARED_EXPORTS) {
    for (const match of text.matchAll(pattern)) {
      record(match[1], kind)
    }
  }
  for (const match of text.matchAll(EXPORT_CLAUSE)) {
    for (const item of match[1].split(',')) {
      // `X` and `X as Y` both export the alias: that is the name a caller imports.
      const [local, alias] = item
        .replace(/\btype\s+/, '')
        .trim()
        .split(/\s+as\s+/)
      record(alias ?? local, 're-export')
    }
  }
  for (const match of text.matchAll(DEFAULT_EXPORT)) {
    if (match[1] === undefined) {
      if (!found.has('default')) {
        found.set('default', 'default')
      }
      continue
    }
    record(match[1], 'default')
  }
  return [...found]
    .map(([name, kind]) => ({ name, kind, anonymous: name === 'default' }))
    .sort((a, b) => (a.name < b.name ? -1 : 1))
}

// The deletions this sync made, with the exported surface of each deleted fork-only module. The
// modified-file scan above cannot see any of this: a deleted file is not in `--diff-filter=M`, and
// a module whose behaviour had a unique side effect is exactly what an "upstream supersedes it"
// call gets wrong.
//
// This proves a scan over deleted paths and export names. It does not prove that no behaviour was
// lost: an export still referenced by a shim, or behaviour that reached the fork through a path
// with no exported name, is outside what it can see.

/**
 * Deletions a reviewer has judged superseded, from `local/sync/expected-deletions.json`.
 *
 * A deleted module legitimately leaves no reference to its exports behind when its behaviour moved
 * into a live module under a different name, so the export scan needs a way to record that verdict
 * rather than failing forever on a supersession someone already checked.
 *
 * `base` is the pinned upstream base: an entry bound to a blob upstream no longer has is a question
 * again, and an entry neither side has any more is prunable.
 */
function readExpectedDeletions(base = null) {
  const file = path.join(repoRoot(), 'local/sync/expected-deletions.json')
  let text = null
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      return {
        acknowledged: {},
        prunable: [],
        failure: `${file} could not be read: ${error instanceof Error ? error.message : String(error)}`
      }
    }
  }
  const at = (ref) =>
    ref === null ? null : new Set(splitNul(gitText(['ls-tree', '-r', '--name-only', '-z', ref])))
  // Why the shared reader: the manifest's shape is `deletions[]` with a per-entry status, and a second
  // reader with its own idea of it is how this check read the retired `acknowledged` key for a week and
  // reported FAILED on every run.
  const manifest = readDeletionManifest({
    text,
    presentAtHead: at('HEAD') ?? new Set(),
    presentUpstream: at(base),
    upstreamBlobOf: (entryPath) =>
      base === null
        ? null
        : gitText(['rev-parse', '--verify', '--quiet', [base, entryPath].join(':')])
  })
  const acknowledged = {}
  for (const entry of manifest.entries) {
    // `pending-decision` acknowledges nothing, and neither does one the binding reopened.
    if (entry.status === 'expected-deletion') {
      acknowledged[entry.path] = { reason: entry.reason }
    }
  }
  return { acknowledged, prunable: manifest.prunable, failure: manifest.failure }
}

export function deletedForkModules(tip, source, problem = null) {
  if (problem !== null) {
    return foreignTipFailure(
      problem,
      'the scan would read the wrong tip and report clean, so it refuses instead'
    )
  }
  if (!tip) {
    return {
      status: STATUS.unavailable,
      summary: `no pre-sync tip: ${BACKUP_REF} is absent and no state file names one`,
      details: [
        'the exported surface of a deleted module can only be read at the pre-sync tip, so this is not a pass'
      ]
    }
  }
  const pinned = pinnedUpstreamBase(tip, source)
  if (pinned.base === null) {
    return {
      status: STATUS.failed,
      summary: `cannot pin the upstream base: ${pinned.problem}`,
      details: [
        'without the pinned base every deleted path reads as fork-only, which is the wrong answer to publish'
      ]
    }
  }
  const base = pinned.base
  const oldBase = gitText(['merge-base', tip, base])
  if (!oldBase) {
    return {
      status: STATUS.failed,
      summary: `no merge base between ${tip.slice(0, 10)} and the pinned base ${base.slice(0, 10)}`,
      details: []
    }
  }
  // Renames off on both sides, deliberately: git pairs a deletion with a similar addition and reports
  // the pair as `R`, which drops the deleted path from the set this classifier reads. Two paths were
  // lost that way — `filesystem-text-search-handler.ts` from our side, and
  // `terminal-file-link-detection-ranges.ts` from upstream's, which then read as a fork-only deletion
  // with a lost export when upstream had simply renamed the file.
  const upstreamChanged = changedNames(['--no-renames', oldBase, base])
  // Renames off here too: see the note above.
  const deleted = changedNames(['--no-renames', '--diff-filter=D', tip, 'HEAD'])
  if (upstreamChanged === null || deleted === null) {
    return {
      status: STATUS.failed,
      summary: `git diff --name-only failed for ${tip.slice(0, 10)}..HEAD`,
      details: [
        'the deleted and upstream-touched sets are unknown, so the scan cannot report clean'
      ]
    }
  }
  const upstreamFiles = new Set(upstreamChanged)
  const forkOnly = []
  const upstreamDeleted = []
  const stillUpstream = []
  for (const file of deleted) {
    if (git(['cat-file', '-e', `${base}:${file}`]).ok) {
      stillUpstream.push(file)
    } else if (upstreamFiles.has(file)) {
      upstreamDeleted.push(file)
    } else {
      forkOnly.push(file)
    }
  }
  const details = [
    `pre-sync tip: ${tip.slice(0, 10)} from ${source}`,
    `deleted between that tip and HEAD, with renames off: ${deleted.length} path(s)`,
    `upstream deleted it too (upstream touched the path in this range and it is gone at the pinned base): ${upstreamDeleted.length}`,
    ...upstreamDeleted.slice(0, 30).map((file) => `  - ${file}`),
    ...(stillUpstream.length === 0
      ? []
      : [
          `still at the pinned base, so the deletion is ours alone: ${stillUpstream.length}`,
          ...stillUpstream.slice(0, 30).map((file) => `  - ${file}`)
        ]),
    `fork-only by construction (absent at the pinned base, untouched upstream in this range): ${forkOnly.length}`,
    ...forkOnly.slice(0, 30).map((file) => `  - ${file}`)
  ]
  const scanFailures = []
  const unreferenced = []
  const acknowledgedUnreferenced = []
  const expectations = readExpectedDeletions(base)
  if (expectations.failure !== null) {
    scanFailures.push(expectations.failure)
  }
  const acknowledgedPaths = Object.keys(expectations.acknowledged)
  // Why presence rather than this sync's deleted set: the manifest settles deletions from every past
  // sync, so asking which of them this one range deleted reads all 22 settled entries as stale on
  // every run. A deletion that is *back* is the thing worth reporting.
  const staleAcknowledgements = acknowledgedPaths.filter((file) =>
    existsSync(path.join(repoRoot(), file))
  )
  const modules = forkOnly.filter(isDeletedCodeModule)
  for (const file of modules) {
    const content = gitText(['show', `${tip}:${file}`])
    if (content === null) {
      // The tip resolves and it is the tip's own HEAD-side path, so a `git show` miss is the probe
      // failing, not an empty module.
      scanFailures.push(`${file}: git show ${tip.slice(0, 10)}:${file} failed`)
      continue
    }
    const exported = exportInventory(content)
    if (exported.length === 0) {
      details.push(`  ${file} — no exported name to cross-check`)
      continue
    }
    details.push(`  ${file} — exported surface at ${tip.slice(0, 10)}:`)
    for (const { name, kind, anonymous } of exported) {
      if (anonymous) {
        details.push(`      default (anonymous, ${kind}) — no name to search for`)
        continue
      }
      // `local/sync/` is excluded because this tool and the ledger name these modules by
      // construction; counting that as a caller would manufacture the clean answer.
      const result = git(['grep', '-l', '-F', '-e', name, 'HEAD', '--', ':!local/sync'])
      if (!result.ok && result.code !== 1) {
        scanFailures.push(
          `${file}: git grep for ${name} exited ${result.code ?? 'without running'} — ${tailText(result.stderr, 2).join(' ')}`
        )
        continue
      }
      const hits = result.ok
        ? result.stdout
            .split('\n')
            .filter(Boolean)
            .map((line) => line.replace(/^HEAD:/, ''))
        : []
      if (hits.length === 0) {
        const ack = expectations.acknowledged[file]
        if (ack) {
          acknowledgedUnreferenced.push(`${file}: ${name}`)
          details.push(
            `      ~ ${name} (${kind}) — no reference left, acknowledged: ${ack.reason || 'no reason recorded'}`
          )
        } else {
          unreferenced.push(`${file}: ${name}`)
          details.push(
            `      ! ${name} (${kind}) — no reference in the live tree: its caller left with it`
          )
        }
      } else {
        details.push(
          `      ${name} (${kind}) — ${hits.length} reference(s): ${hits.slice(0, 3).join(', ')}`
        )
      }
    }
  }
  if (staleAcknowledgements.length > 0) {
    details.push(
      `acknowledged deletions that are present again (stale entries in local/sync/expected-deletions.json): ${staleAcknowledgements.length}`
    )
    for (const file of staleAcknowledgements) {
      details.push(`  ? ${file}`)
    }
  }
  for (const file of expectations.prunable) {
    details.push(`  ? ${file} — in the manifest, but neither side has it any more: prune the entry`)
  }
  if (acknowledgedUnreferenced.length > 0) {
    details.push(
      `acknowledged as superseded, so not counted against the scan: ${acknowledgedUnreferenced.length}`
    )
  }
  details.push(
    `scanned ${modules.length} deleted fork-only code module(s) for names the live tree no longer references`
  )
  details.push(
    'this is a scan of deleted paths and export names, not proof that no behaviour was lost'
  )
  if (scanFailures.length > 0) {
    return {
      status: STATUS.failed,
      summary: `the exported surface could not be read for ${scanFailures.length} deleted path(s)`,
      details: [...scanFailures.map((line) => `  ! ${line}`), ...details]
    }
  }
  return {
    status: unreferenced.length === 0 ? STATUS.passed : STATUS.failed,
    summary:
      unreferenced.length === 0
        ? `clear scan: no unreviewed unreferenced export among ${modules.length} deleted fork-only module(s)`
        : `${unreferenced.length} export(s) of deleted fork-only module(s) have no surviving reference`,
    details:
      unreferenced.length === 0
        ? details
        : [...unreferenced.map((line) => `  ! ${line}`), ...details]
  }
}
