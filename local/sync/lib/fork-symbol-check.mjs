// The git half of the fork-symbol survival check, in the `{ status, summary, details }` shape and
// with the same preconditions as `deletedForkModules` (post-sync-checks.mjs), so a driver can list
// the two side by side. Read-only: diff, merge-base, cat-file and grep.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parseExpectedSymbols } from './expected-deletions.mjs'
import { forkAdded, forkSurface, manifestEntry, survivalVerdict } from './fork-symbols.mjs'
import { blobs, upstreamMoves } from './fork-surface-git.mjs'
import { addedLines } from './rename-forecast.mjs'
import { isDeletedCodeModule } from './post-sync-checks.mjs'
import { BACKUP_REF, pinnedUpstreamBase } from './sync-range.mjs'
import { STATUS, git, gitText, repoRoot, splitNul, tailText } from './run.mjs'

function readManifestSymbols() {
  const file = path.join(repoRoot(), 'local/sync/expected-deletions.json')
  try {
    return parseExpectedSymbols(readFileSync(file, 'utf8'))
  } catch (error) {
    return { entries: [], note: `${file} unreadable: ${error.message}` }
  }
}

const wholeWord = (name) =>
  new RegExp(`(?<![A-Za-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`)

function gitOrThrow(args) {
  const result = git(args)
  if (!result.ok && result.code !== 1) {
    throw new Error(`git ${args[0]} exited ${result.code}: ${tailText(result.stderr, 2).join(' ')}`)
  }
  return result
}

/**
 * Bare names with a whole-word hit in the merged tree (outside local/sync) on more lines of a file
 * than the fork itself added there: the fork's own tests, comments and stale callers are not a home.
 */
function referencedNames({ oldBase, tip, merged, renames, names }) {
  const found = new Set()
  const unique = [...new Set(names)]
  if (unique.length === 0) {
    return found
  }
  const hitsByName = new Map()
  for (const name of unique) {
    // Counts, not lines: a common member name can occur thousands of times.
    const result = gitOrThrow([
      'grep',
      '-c',
      '-z',
      '-w',
      '-F',
      '-e',
      name,
      merged,
      '--',
      '.',
      ':!local/sync'
    ])
    const hits = []
    for (const row of result.ok ? result.stdout.split('\n') : []) {
      const [where, count] = row.split('\0')
      if (count !== undefined) {
        hits.push([where.slice(merged.length + 1), Number(count)])
      }
    }
    hitsByName.set(name, hits)
  }
  const forkRows = addedLines(
    gitOrThrow(['diff', '-U0', '--no-color', '--no-renames', '--diff-filter=AM', oldBase, tip])
      .stdout
  )
  const tipPathOf = new Map([...renames].map(([from, to]) => [to, from]))
  const tipPath = (file) => tipPathOf.get(file) ?? file
  const hitFiles = new Set([...hitsByName.values()].flat().map(([file]) => tipPath(file)))
  const texts = blobs(
    [...hitFiles].filter((file) => forkRows.has(file)).map((file) => `${tip}:${file}`)
  )
  const forkLines = new Map()
  const forkText = (file) => {
    if (!forkLines.has(file)) {
      const rows = (texts.get(`${tip}:${tipPath(file)}`) ?? '').split('\n')
      const added = [...(forkRows.get(tipPath(file)) ?? [])]
      forkLines.set(
        file,
        added.map((row) => rows[row - 1] ?? '')
      )
    }
    return forkLines.get(file)
  }
  for (const [name, hits] of hitsByName) {
    const pattern = wholeWord(name)
    if (
      hits.some(
        ([file, count]) => count > forkText(file).filter((line) => pattern.test(line)).length
      )
    ) {
      found.add(name)
    }
  }
  return found
}

/** The scan proper, given the three commits; `newBase` is only used to follow upstream renames. */
export function scanForkSymbols({ oldBase, tip, newBase, merged = 'HEAD' }) {
  // During conflict resolution HEAD is still the pre-sync tip, and comparing it with itself is clear.
  for (const [label, commit] of [
    ['pre-sync tip', tip],
    ['new base', newBase]
  ]) {
    const ancestry = git(['merge-base', '--is-ancestor', commit, merged])
    if (!ancestry.ok) {
      return {
        status: STATUS.failed,
        summary:
          ancestry.code === 1
            ? `${merged} does not contain the ${label} ${commit.slice(0, 10)}, so it is not the merge result`
            : `git merge-base --is-ancestor ${commit.slice(0, 10)} ${merged} failed`,
        details: [
          'commit the merge first, or pass --merged <the merge commit>; this is not a pass',
          ...tailText(ancestry.stderr, 2)
        ]
      }
    }
  }
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
  const referenced = referencedNames({
    oldBase,
    tip,
    merged,
    renames,
    names: pending.flatMap((item) =>
      item.added
        .filter((symbol) => !item.now.has(symbol.name))
        .map((symbol) => symbol.name.split('.').at(-1))
    )
  })
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
  const relocated = results.filter((result) => result.verdict === 'relocated')
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
        `  ? ${label} — gone from this file; the name is on a line the fork did not add: moved? review it`
      )
    } else {
      details.push(`  ! ${label} — no reference left in the merged tree`)
    }
  }
  details.push(
    'this compares declared names, not behaviour: a branch dropped inside a surviving function is invisible to it'
  )
  const outcome = { details, results, manifestEntries: [...lost, ...relocated].map(manifestEntry) }
  if (scanFailures.length > 0) {
    return {
      ...outcome,
      status: STATUS.failed,
      summary: `the fork surface could not be read for ${scanFailures.length} file(s)`,
      details: [...scanFailures.map((line) => `  ! ${line}`), ...details]
    }
  }
  const unreviewed = lost.length + relocated.length
  return {
    ...outcome,
    status: unreviewed === 0 ? STATUS.passed : STATUS.failed,
    summary:
      unreviewed === 0
        ? `clear scan: no unreviewed lost or relocated name among ${files.length} fork-touched module(s)`
        : `${lost.length} fork-added name(s) the merged tree no longer declares or references; ${relocated.length} relocated name(s) to review`
  }
}

export function forkSymbolSurvival(tip, source, { merged = 'HEAD', problem = null } = {}) {
  if (problem !== null) {
    return {
      status: STATUS.failed,
      summary: `the pre-sync tip does not belong to this sync: ${problem}`,
      details: [
        'the scan would read the wrong tip and report clean, so it refuses instead',
        're-run `node local/sync/pre-sync.mjs --prepare` before relying on this check'
      ]
    }
  }
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
