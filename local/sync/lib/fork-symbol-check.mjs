// The git half of the fork-symbol survival check, in the `{ status, summary, details }` shape and
// with the same preconditions as `deletedForkModules` (post-sync-checks.mjs), so a driver can list
// the two side by side. Read-only: diff, merge-base, cat-file and grep.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parseExpectedSymbols } from './expected-deletions.mjs'
import { forkAdded, forkSurface, manifestEntry, survivalVerdict } from './fork-symbols.mjs'
import { blobs, upstreamMoves } from './fork-surface-git.mjs'
import { BACKUP_REF, isDeletedCodeModule, pinnedUpstreamBase } from './post-sync-checks.mjs'
import { STATUS, git, gitText, repoRoot, splitNul, tailText } from './run.mjs'

function readManifestSymbols() {
  const file = path.join(repoRoot(), 'local/sync/expected-deletions.json')
  try {
    return parseExpectedSymbols(readFileSync(file, 'utf8'))
  } catch (error) {
    return { entries: [], note: `${file} unreadable: ${error.message}` }
  }
}

/** Bare names that still occur as a whole word anywhere in the merged tree outside local/sync. */
function referencedNames(merged, names) {
  const found = new Set()
  // One existence probe per name: a batched `-o` prints every occurrence of a common member name.
  for (const name of new Set(names)) {
    const result = git(['grep', '-q', '-w', '-F', '-e', name, merged, '--', '.', ':!local/sync'])
    if (!result.ok && result.code !== 1) {
      throw new Error(`git grep exited ${result.code}: ${tailText(result.stderr, 2).join(' ')}`)
    }
    if (result.ok) {
      found.add(name)
    }
  }
  return found
}

/** The scan proper, given the three commits; `newBase` is only used to follow upstream renames. */
export function scanForkSymbols({ oldBase, tip, newBase, merged = 'HEAD' }) {
  const listed = git([
    'diff',
    '-z',
    '--name-status',
    '--no-renames',
    '--diff-filter=AM',
    oldBase,
    tip
  ])
  if (!listed.ok) {
    return {
      status: STATUS.failed,
      summary: `git diff ${oldBase.slice(0, 10)}..${tip.slice(0, 10)} failed`,
      details: tailText(listed.stderr, 3)
    }
  }
  const fields = splitNul(listed.stdout)
  const files = []
  for (let index = 0; index < fields.length; index += 2) {
    if (isDeletedCodeModule(fields[index + 1])) {
      files.push({ status: fields[index], path: fields[index + 1] })
    }
  }
  const { renames } = upstreamMoves(oldBase, newBase)
  const mergedPath = (file) => renames.get(file) ?? file
  const texts = blobs(
    files.flatMap((file) => [
      ...(file.status === 'M' ? [`${oldBase}:${file.path}`] : []),
      `${tip}:${file.path}`,
      `${merged}:${mergedPath(file.path)}`
    ])
  )
  const manifest = readManifestSymbols()
  const scanFailures = manifest.note ? [manifest.note] : []
  const pending = []
  for (const file of files) {
    const target = mergedPath(file.path)
    const mergedText = texts.get(`${merged}:${target}`)
    if (mergedText === null && file.status === 'A') {
      continue // a deleted fork-only module is deletedForkModules' row, not this one
    }
    const after = forkSurface(file.path, texts.get(`${tip}:${file.path}`))
    const before =
      file.status === 'M' ? forkSurface(file.path, texts.get(`${oldBase}:${file.path}`)) : null
    const now = mergedText === null ? new Map() : forkSurface(target, mergedText)
    if (after === null || now === null || (file.status === 'M' && before === null)) {
      scanFailures.push(`${file.path}: a side does not parse, so its names cannot be compared`)
      continue
    }
    const added = forkAdded(before, after)
    if (added.some((symbol) => !now.has(symbol.name))) {
      pending.push({ file, target, added, now, gone: mergedText === null })
    }
  }
  const referenced = referencedNames(
    merged,
    pending.flatMap((item) =>
      item.added
        .filter((symbol) => !item.now.has(symbol.name))
        .map((symbol) => symbol.name.split('.').at(-1))
    )
  )
  const results = pending.flatMap((item) =>
    survivalVerdict({
      path: item.file.path,
      added: item.added,
      merged: item.now,
      referenced,
      acknowledgements: manifest.entries
    }).map((result) => ({ ...result, mergedPath: item.target, fileGone: item.gone }))
  )
  const lost = results.filter((result) => result.verdict === 'lost')
  const details = [
    `old base ${oldBase.slice(0, 10)}, pre-sync tip ${tip.slice(0, 10)}, merged ${merged}`,
    `scanned ${files.length} fork-added or fork-modified code module(s) for names the merged file no longer declares`
  ]
  for (const result of results) {
    const where = result.mergedPath === result.path ? '' : ` (now ${result.mergedPath})`
    const label = `${result.path}:${result.line}${where} ${result.name} (${result.kind}${result.fileGone ? ', file gone' : ''})`
    if (result.verdict === 'acknowledged') {
      details.push(
        `  ~ ${label} — acknowledged as superseded by ${result.supersededBy ?? 'an unnamed replacement'}`
      )
    } else if (result.verdict === 'relocated') {
      details.push(
        `  ? ${label} — gone from this file, but the name still appears elsewhere: moved?`
      )
    } else {
      details.push(`  ! ${label} — no reference left in the merged tree`)
    }
  }
  details.push(
    'this compares declared names, not behaviour: a branch dropped inside a surviving function is invisible to it'
  )
  const outcome = { details, results, manifestEntries: lost.map(manifestEntry) }
  if (scanFailures.length > 0) {
    return {
      ...outcome,
      status: STATUS.failed,
      summary: `the fork surface could not be read for ${scanFailures.length} file(s)`,
      details: [...scanFailures.map((line) => `  ! ${line}`), ...details]
    }
  }
  return {
    ...outcome,
    status: lost.length === 0 ? STATUS.passed : STATUS.failed,
    summary:
      lost.length === 0
        ? `clear scan: no unreviewed lost name among ${files.length} fork-touched module(s)`
        : `${lost.length} fork-added name(s) the merged tree no longer declares or references`
  }
}

export function forkSymbolSurvival(tip, source, { merged = 'HEAD' } = {}) {
  if (!tip) {
    return {
      status: STATUS.unavailable,
      summary: `no pre-sync tip: ${BACKUP_REF} is absent and no state file names one`,
      details: ['the fork-added names can only be read at the pre-sync tip, so this is not a pass']
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
    return {
      status: STATUS.failed,
      summary: `no merge base between ${tip.slice(0, 10)} and the pinned base ${pinned.base.slice(0, 10)}`,
      details: []
    }
  }
  return scanForkSymbols({ oldBase, tip, newBase: pinned.base, merged })
}
