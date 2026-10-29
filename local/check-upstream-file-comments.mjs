#!/usr/bin/env node
/**
 * Ratchet for fork comments in files upstream owns.
 *
 * `LOCAL-PATCHES.md` forbids them: a rationale paragraph above upstream's code is conflict
 * adjacency and nothing else, and the 2026-10-28 sync showed it — 162 of 233 pending conflicts came
 * from exactly this, and 73% of that sync's hunks had an upstream side that had changed only
 * comments. Nothing enforced the rule, so the fork carried ~6,000 added comment lines in 1,026
 * upstream-modified files and kept adding them.
 *
 * The baseline freezes that set and may only shrink. Per-file maxima are recorded where the cost is
 * concentrated (`PER_FILE_THRESHOLD` and above); below it, growth is only visible in the total, which
 * is frozen too — so moving comment lines between two files under the threshold keeps the total and
 * passes, which is the price of a readable baseline. A file that needs a fork comment anyway can say
 * so on the line:
 *
 *   // fork-comment-ok: <why this must live upstream>
 *
 * The measurement is always "what this branch added to files upstream modified", i.e. against the
 * current upstream merge base, so a sync moves the ruler with it instead of counting upstream's own
 * new comments as fork growth. Growth still needs an explicit `--accept <reason>`; a fork-renamed
 * upstream file shows up as delete+add and is not counted (rename detection would hide it either way).
 *
 * Usage: node local/check-upstream-file-comments.mjs [--init [--base <sha>] [--accept <reason>]] [--prune] [--verbose]
 *
 *   --init   rewrite the baseline at the current diff (growth is refused unless --accept says why)
 *   --prune  drop entries whose file no longer carries fork comments, and lower the total to it
 *
 * Exit: 0 pass, 1 new red, 2 usage or environment problem.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '..')
const BASELINE_RELATIVE_PATH = path.join('local', 'upstream-file-comments-baseline.json')
const MARKER = 'fork-comment-ok'
// Max-lines exemptions are mandated by the lint rule, so they are not the fork talking.
const MAX_LINES_DIRECTIVE_RE = /(?:eslint|oxlint)-disable[^\n]*\bmax-lines\b/
// Where the conflict cost concentrates; below this a file only feeds the total.
export const PER_FILE_THRESHOLD = 5
// `#` starts a comment only where the file cannot read it as syntax.
const HASH_COMMENT_EXTENSIONS = new Set(['.yml', '.yaml', '.sh', '.bash', '.zsh', '.toml'])

function usage() {
  return 'usage: node local/check-upstream-file-comments.mjs [--init [--base <sha>] [--accept <reason>]] [--prune] [--verbose]'
}

export function parseArgs(argv) {
  const options = { init: false, prune: false, base: null, accept: null, verbose: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--init') {
      options.init = true
    } else if (arg === '--prune') {
      options.prune = true
    } else if (arg === '--base') {
      options.base = argv[(index += 1)] ?? null
      if (!options.base) {
        throw new Error('--base needs a revision')
      }
    } else if (arg === '--accept') {
      options.accept = (argv[(index += 1)] ?? '').trim()
      if (!options.accept) {
        throw new Error('--accept needs a reason')
      }
    } else if (arg === '--verbose') {
      options.verbose = true
    } else if (arg === '--help' || arg === '-h') {
      console.log(usage())
      process.exit(0)
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  if (options.init && options.prune) {
    throw new Error('--init and --prune are different rewrites; pick one')
  }
  if (options.accept && !options.init) {
    throw new Error('--accept only applies to --init')
  }
  return options
}

/**
 * A line counts as a fork comment when its first non-space characters open or continue one, in a
 * shape the file's language actually reads as a comment.
 */
export function isCommentLine(text, filePath = '') {
  if (/^\s*(?:\/\/|\/\*|\*(?!\/)|\{\/\*|<!--)/.test(text)) {
    return true
  }
  return HASH_COMMENT_EXTENSIONS.has(path.extname(filePath)) && /^\s*#/.test(text)
}

function isExemptDirective(text) {
  return MAX_LINES_DIRECTIVE_RE.test(text)
}

/**
 * Added comment lines per file, from a unified diff against the sync base.
 *
 * Only `M` files are diffed: a fork-added file is `A`, and a file nobody upstream owns cannot be
 * conflict adjacency. `fork-comment-ok:` exempts its own line and the added comment lines that
 * follow it until anything else — code, context, a hunk boundary — interrupts the block.
 *
 * The parser is deliberately strict about the file header: a `git config` that changes the diff
 * prefixes or quotes paths (`diff.mnemonicPrefix`, `diff.noprefix`, `core.quotePath`) would hide
 * every path, and silently counting zero is worse than failing.
 */
export function collectAddedCommentLines(diffText) {
  const perFile = new Map()
  let file = null
  let awaitingFileHeader = false
  let sawFileHeader = false
  let markerActive = false
  for (const raw of diffText.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      file = null
      awaitingFileHeader = true
      sawFileHeader = false
      markerActive = false
      continue
    }
    if (raw.startsWith('index ') || raw.startsWith('new file mode') || raw.startsWith('old mode')) {
      continue
    }
    if (awaitingFileHeader && raw.startsWith('--- ')) {
      continue
    }
    if (awaitingFileHeader && raw.startsWith('+++ ')) {
      awaitingFileHeader = false
      sawFileHeader = true
      const header = raw.slice('+++ '.length)
      // `+++ /dev/null` is a deletion; `+++ b/<path>` is the shape we asked git for.
      if (header === '/dev/null') {
        file = null
      } else if (header.startsWith('b/')) {
        file = header.slice(2)
      } else {
        throw new Error(`unexpected diff header "${raw}" — git is prefixing paths unexpectedly`)
      }
      continue
    }
    if (raw.startsWith('@@')) {
      markerActive = false
      continue
    }
    if (raw.startsWith('-')) {
      markerActive = false
      continue
    }
    if (!raw.startsWith('+')) {
      // Context (and `\ No newline at end of file`) ends a marked block.
      if (raw.trim().length > 0) {
        markerActive = false
      }
      continue
    }
    if (file === null) {
      // An added line in a file whose path we could not read would vanish from the count.
      if (sawFileHeader) {
        // A deletion (+++ /dev/null) carries no added content worth counting.
        continue
      }
      throw new Error('an added line appeared before a parseable file header')
    }
    const text = raw.slice(1)
    if (!isCommentLine(text, file)) {
      if (text.trim().length > 0) {
        markerActive = false
      }
      continue
    }
    if (text.includes(MARKER)) {
      markerActive = true
      continue
    }
    if (markerActive || isExemptDirective(text)) {
      continue
    }
    perFile.set(file, (perFile.get(file) ?? 0) + 1)
  }
  return perFile
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })
}

/** A probe whose failure is expected (a clone with no upstream remote), with git's stderr silenced. */
function gitOrNull(root, args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return null
  }
}

/**
 * The revision the count is taken against: the current upstream merge base, so the fork's own
 * additions are what is measured and a sync moves the ruler rather than inflating the count.
 */
export function resolveBase(root, requestedBase, baseline) {
  if (requestedBase) {
    return git(root, ['rev-parse', '--verify', `${requestedBase}^{commit}`]).trim()
  }
  const mergeBase = gitOrNull(root, ['merge-base', 'HEAD', 'upstream/main'])
  if (mergeBase) {
    return mergeBase
  }
  // A clone without the upstream remote (a CI shard, a shallow export) falls back to the recorded
  // base, which is why the baseline keeps one.
  if (baseline?.base) {
    return baseline.base
  }
  throw new Error('no upstream/main merge base and no recorded base; pass --base <sha>')
}

export function readBaseline(root) {
  const baselinePath = path.join(root, BASELINE_RELATIVE_PATH)
  if (!existsSync(baselinePath)) {
    return null
  }
  try {
    return JSON.parse(readFileSync(baselinePath, 'utf8'))
  } catch (error) {
    throw new Error(`${BASELINE_RELATIVE_PATH} is not valid JSON: ${error.message}`)
  }
}

function buildBaseline(counts, base, accepted) {
  const files = {}
  let total = 0
  for (const [file, count] of [...counts].sort(([left], [right]) => left.localeCompare(right))) {
    total += count
    if (count >= PER_FILE_THRESHOLD) {
      files[file] = count
    }
  }
  return {
    note:
      'Fork comments in upstream-owned files (LOCAL-PATCHES.md). Frozen per-file maxima at or above ' +
      `${PER_FILE_THRESHOLD} lines plus the frozen total; both may only shrink. Regenerate with ` +
      '`node local/check-upstream-file-comments.mjs --init`.',
    base,
    perFileThreshold: PER_FILE_THRESHOLD,
    ...(accepted ? { accepted } : {}),
    total,
    files
  }
}

function writeBaseline(root, baseline) {
  writeFileSync(
    path.join(root, BASELINE_RELATIVE_PATH),
    `${JSON.stringify(baseline, null, 2)}\n`,
    'utf8'
  )
}

function currentCounts(root, base, verbose) {
  // Pin the diff shape: a configured prefix or a quoting mode is how this check would read zero.
  const diffText = git(root, [
    '--no-pager',
    '-c',
    'core.quotePath=false',
    'diff',
    '--diff-filter=M',
    '--no-renames',
    '--no-ext-diff',
    '--no-color',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    base,
    '--'
  ])
  const counts = collectAddedCommentLines(diffText)
  if (verbose) {
    const total = [...counts.values()].reduce((sum, count) => sum + count, 0)
    console.log(`counted ${total} fork comment line(s) across ${counts.size} file(s) since ${base}`)
  }
  return counts
}

/**
 * Violations against the frozen set: a new offender, a file past its recorded maximum, or a total that
 * moved at all. "Moved" includes shrinking — the baseline only records a lower number when someone
 * runs `--prune`, which is what stops slack from being spent elsewhere.
 */
export function evaluate(counts, baseline) {
  const violations = []
  const perFile = baseline.files ?? {}
  for (const [file, count] of [...counts].sort(([left], [right]) => left.localeCompare(right))) {
    const allowed = perFile[file]
    if (allowed === undefined) {
      if (count >= (baseline.perFileThreshold ?? PER_FILE_THRESHOLD)) {
        violations.push({ file, count, allowed: 0 })
      }
      continue
    }
    if (count > allowed) {
      violations.push({ file, count, allowed })
    }
  }
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0)
  const stale = Object.keys(perFile).filter((file) => !counts.has(file))
  return { violations, total, totalAllowed: baseline.total, stale }
}

function report(result) {
  const overTotal = result.total > result.totalAllowed
  const shrunk = result.total < result.totalAllowed
  if (!overTotal && !shrunk && result.violations.length === 0) {
    console.log(
      `Fork comments in upstream files: ${result.total}/${result.totalAllowed} line(s), ` +
        `${result.stale.length} stale baseline entr(ies).`
    )
    return 0
  }
  console.error(
    'Fork comments in upstream-owned files moved against the frozen baseline.\n' +
      'LOCAL-PATCHES.md: the reason belongs in the ledger or a fork-owned module, not above\n' +
      `upstream's code. If it truly must live there, mark the block with \`${MARKER}: <why>\`.\n`
  )
  for (const violation of result.violations) {
    console.error(
      `::error file=${violation.file}::${violation.count} fork comment line(s), baseline ${violation.allowed}`
    )
  }
  if (overTotal) {
    console.error(
      `::error::${result.total} fork comment lines in total, baseline ${result.totalAllowed}`
    )
  }
  if (shrunk) {
    console.error(
      `::error::${result.total} fork comment lines in total, baseline ${result.totalAllowed} — ` +
        'run --prune so the shrink is locked in and cannot be spent again'
    )
  }
  if (result.stale.length > 0) {
    console.error(
      `note: ${result.stale.length} baseline entr(ies) no longer carry comments; ` +
        'run --prune so they cannot come back.'
    )
  }
  return 1
}

export function main(argv = process.argv.slice(2), root = ROOT) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(`${error.message}\n${usage()}`)
    return 2
  }
  let baseline
  let base
  let counts
  try {
    baseline = readBaseline(root)
    base = resolveBase(root, options.base, baseline)
    counts = currentCounts(root, base, options.verbose)
  } catch (error) {
    console.error(`cannot measure fork comments: ${error.message}`)
    return 2
  }

  if (options.init) {
    const next = buildBaseline(counts, base, options.accept)
    // Growth is judged per file as well as in total: moving comments out of a listed file into an
    // unlisted one would otherwise be recorded as a new entry with no reason at all.
    const previousFiles = baseline?.files ?? {}
    const grownFiles = Object.entries(next.files).filter(
      ([file, count]) => count > (previousFiles[file] ?? 0)
    )
    const grew = Boolean(baseline) && (next.total > baseline.total || grownFiles.length > 0)
    if (grew && !options.accept) {
      console.error(
        `::error::the baseline may only shrink: this diff has ${next.total} comment line(s) ` +
          `against a recorded ${baseline.total}` +
          `${grownFiles.length > 0 ? `, and ${grownFiles.length} file(s) at or past the per-file threshold grew` : ''}` +
          ". Pass --accept <reason> when the growth is not this branch's to fix."
      )
      return 1
    }
    writeBaseline(root, next)
    console.log(
      `Wrote ${BASELINE_RELATIVE_PATH}: ${next.total} line(s)` +
        `${baseline ? ` (was ${baseline.total})` : ''}, ` +
        `${Object.keys(next.files).length} per-file entr(ies), base ${base.slice(0, 11)}.`
    )
    if (grew) {
      console.log(`Accepted growth: ${options.accept}`)
    }
    return 0
  }

  if (!baseline) {
    console.error(
      `::error::Missing ${BASELINE_RELATIVE_PATH}. Generate it with \`--init\` against the sync base.`
    )
    return 1
  }

  if (options.prune) {
    const kept = {}
    for (const [file, allowed] of Object.entries(baseline.files ?? {})) {
      if (!counts.has(file)) {
        continue
      }
      kept[file] = Math.min(allowed, counts.get(file))
    }
    const total = [...counts.values()].reduce((sum, count) => sum + count, 0)
    if (total > baseline.total) {
      console.error(
        `::error::--prune does not raise the total: current diff has ${total}, baseline ${baseline.total}`
      )
      return 1
    }
    writeBaseline(root, { ...baseline, base, total, files: kept })
    console.log(
      `Pruned ${BASELINE_RELATIVE_PATH} to ${Object.keys(kept).length} per-file entr(ies), ` +
        `${total} line(s) total.`
    )
    return 0
  }

  return report(evaluate(counts, baseline))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main())
}
