// Git reads for the rename forecast and the fork-symbol survival check. Read-only: diff, ls-tree and
// cat-file only. Every failed read throws, because an empty answer here would read as "nothing lost".
import { spawnSync } from 'node:child_process'
import { addedLines, forecastRenames, parseNameStatus, referencesIn } from './rename-forecast.mjs'
import { git, repoRoot, splitNul } from './run.mjs'
import { scriptKindFor } from './ts-source.mjs'

function gitOut(args) {
  const result = git(args)
  if (!result.ok) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim().split('\n')[0]}`)
  }
  return result.stdout
}

export const resolveCommit = (ref) => gitOut(['rev-parse', '--verify', `${ref}^{commit}`]).trim()

export const treeFiles = (commit) =>
  splitNul(gitOut(['ls-tree', '-r', '-z', '--name-only', commit]))

/** Blob text for each `rev:path`, in one `git cat-file --batch`; a missing object maps to null. */
export function blobs(specs) {
  const out = new Map()
  if (specs.length === 0) {
    return out
  }
  const result = spawnSync('git', ['cat-file', '--batch'], {
    cwd: repoRoot(),
    input: `${specs.join('\n')}\n`,
    maxBuffer: 1024 * 1024 * 1024
  })
  if (result.status !== 0) {
    throw new Error(`git cat-file --batch failed: ${String(result.stderr).trim()}`)
  }
  const buffer = result.stdout
  let offset = 0
  for (const spec of specs) {
    const newline = buffer.indexOf(10, offset)
    const header = buffer.subarray(offset, newline).toString('utf8')
    offset = newline + 1
    const size = /^[0-9a-f]+ blob (\d+)$/.exec(header)
    if (!size) {
      out.set(spec, null)
      continue
    }
    const length = Number(size[1])
    out.set(spec, buffer.subarray(offset, offset + length).toString('utf8'))
    offset += length + 1
  }
  return out
}

export function upstreamMoves(oldBase, newBase) {
  return parseNameStatus(
    gitOut(['diff', '-z', '--name-status', '-M', '--diff-filter=RD', oldBase, newBase])
  )
}

export function renameForecast({ oldBase, newBase, tip }) {
  const [from, to, at] = [resolveCommit(oldBase), resolveCommit(newBase), resolveCommit(tip)]
  const { renames, deletions } = upstreamMoves(from, to)
  const forkLines = addedLines(
    gitOut(['diff', '-U0', '--no-color', '--no-renames', '--diff-filter=AM', from, at])
  )
  const scanned = [...forkLines.keys()].filter((file) => scriptKindFor(file) !== null)
  const texts = blobs(scanned.map((file) => `${at}:${file}`))
  const references = scanned.flatMap((file) =>
    referencesIn(file, texts.get(`${at}:${file}`), forkLines.get(file)).map((ref) => ({
      file,
      ...ref
    }))
  )
  const report = forecastRenames({
    renames,
    deletions,
    oldBaseFiles: treeFiles(from),
    tipFiles: treeFiles(at),
    newBaseFiles: treeFiles(to),
    references
  })
  return {
    range: `${from.slice(0, 10)}..${to.slice(0, 10)} against fork tip ${at.slice(0, 10)}`,
    oldBase: from,
    newBase: to,
    tip: at,
    ...report
  }
}
