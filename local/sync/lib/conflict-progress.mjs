// The one line a resolver round is read from, so a round is not a `git status | grep -c` per question:
//
//   unmerged 102 (UU 98, UD 3, DU 1) · staged since merge 221 · proven-unstaged 0 · batches a 13/14
//
// git access comes in as `gitText` and `worktreeText` so this module stays free of the caller's
// plumbing and is testable from fixtures alone.

import { readFileSync } from 'node:fs'
import { parseConflictHunks } from './conflict-classify.mjs'

const UNMERGED = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

export const unmergedPaths = (gitText) =>
  (gitText(['diff', '--name-only', '--diff-filter=U', '-z']) ?? '').split('\u0000').filter(Boolean)

// One porcelain pass answers both questions the progress line asks: which paths are unmerged and by
// which code, and what the index has staged since the operation started.
export function indexStatus(gitText) {
  const statuses = new Map()
  const staged = new Set()
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
    } else if (code[0] !== ' ' && code[0] !== '?') {
      staged.add(record.slice(3))
    }
    extraPath = code.startsWith('R') || code.startsWith('C')
  }
  return { statuses, staged }
}

// A delete-shaped path is a `git rm`/`git add` decision, never a fix written and waiting to be staged.
const DELETE_SHAPED = new Set(['DD', 'UD', 'DU'])

export function countByCode(paths, statuses) {
  const byCode = {}
  for (const path of paths) {
    const code = statuses.get(path)
    if (code) {
      byCode[code] = (byCode[code] ?? 0) + 1
    }
  }
  return byCode
}

// Unmerged in the index and marker-free on disk: a resolution that exists but is not staged, whatever
// wrote it (`--apply-proven`, a resolver, or a hand edit).
export function countUnstagedFixes(paths, statuses, worktreeText) {
  let count = 0
  for (const path of paths) {
    if (DELETE_SHAPED.has(statuses.get(path))) {
      continue
    }
    const text = worktreeText(path)
    if (text !== null && parseConflictHunks(text).length === 0) {
      count += 1
    }
  }
  return count
}

export function countSegment(total, byCode) {
  const parts = Object.entries(byCode)
    .sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1))
    .map(([code, count]) => `${code} ${count}`)
  return parts.length === 0 ? `unmerged ${total}` : `unmerged ${total} (${parts.join(', ')})`
}

export function readBatchPaths(batch) {
  let text
  try {
    text = readFileSync(batch.file, 'utf8')
  } catch (error) {
    throw new Error(
      `--batch ${batch.label}: cannot read ${batch.file} (${error.code ?? error.message})`
    )
  }
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
}

// A path is resolved when git no longer calls it unmerged; the batch's own list is its denominator.
export function batchSegment(batches, unmerged) {
  const rows = batches.map((batch) => {
    const paths = readBatchPaths(batch)
    return `${batch.label} ${paths.filter((path) => !unmerged.has(path)).length}/${paths.length}`
  })
  return `batches ${rows.join(' ')}`
}

export function liveProgress({ gitText, worktreeText }) {
  const { statuses, staged } = indexStatus(gitText)
  const paths = [...new Set([...statuses.keys(), ...unmergedPaths(gitText)])]
  return {
    total: paths.length,
    byCode: countByCode(paths, statuses),
    staged: staged.size,
    provenUnstaged: countUnstagedFixes(paths, statuses, worktreeText),
    unmerged: new Set(paths)
  }
}

// A --merge-tree run has no index, so the two index facts are named as unavailable rather than
// silently dropped from a line whose shape is the point.
export function treeProgress(files) {
  const statuses = new Map(
    files.filter((file) => file.status).map((file) => [file.path, file.status])
  )
  const paths = files.map((file) => file.path)
  return {
    total: paths.length,
    byCode: countByCode(paths, statuses),
    staged: null,
    provenUnstaged: null,
    unmerged: new Set(paths)
  }
}

export function progressLine(progress, batches = []) {
  const segments = [
    countSegment(progress.total, progress.byCode),
    `staged since merge ${progress.staged ?? 'n/a'}`,
    `proven-unstaged ${progress.provenUnstaged ?? 'n/a'}`
  ]
  if (batches.length > 0) {
    segments.push(batchSegment(batches, progress.unmerged))
  }
  return segments.join(' · ')
}
