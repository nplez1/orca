#!/usr/bin/env node
// Post-sync smoke selector: print the unit tests a fork-surface smoke run should execute after a
// merge — the tests the fork-side diff touches plus the tests coupled one import level away,
// reusing `local/gate-flake-coupling.mjs`'s coupling so this and the flake waiver cannot drift
// apart about what "coupled" means (plan §6.1).
//
//   node local/sync/smoke-selector.mjs 281cccf5a4 --dry-run
//   node local/sync/smoke-selector.mjs 281cccf5a4             # one path per line, for a runner
//   node local/sync/smoke-selector.mjs <base>..<head> --json
//
// A merge revision selects the fork side (`merge-base(M^1,M^2)..M^1`) and reads test files and
// their imports AT THE MERGE COMMIT — the tree the smoke run would execute. A plain commit is
// `M^1..M`; an explicit range is used as given, with the head as the tree.
//
// Read-only git. --dry-run prints the selection, its flat timing estimate, and every dropped or
// truncated file: silent truncation would make the audit impossible.

import { spawn, execFileSync } from 'node:child_process'
import process from 'node:process'
import { UNIT_EXCLUDE, UNIT_INCLUDE } from '../../config/scripts/ci-unit-files.mjs'
import {
  SECONDS_PER_TEST_FILE,
  droppedTouchedTests,
  estimateSeconds,
  harnessCoupling,
  isTestFile,
  selectSmokeTests,
  unitCandidates
} from './lib/smoke-select.mjs'

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const NO_COUPLING = (file) => [file]
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
// A batch's request lines must stay under the OS pipe buffer so `cat-file` never blocks on stdout
// while this side is still writing stdin; 2000 paths is well under 64 KB.
const BATCH = 2000
const DEFAULT_LIMIT = 200

function parseArgs(argv) {
  const options = {
    range: null,
    dryRun: false,
    json: false,
    touchedOnly: false,
    limit: DEFAULT_LIMIT,
    help: false
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--dry-run') {
      options.dryRun = true
    } else if (flag === '--touched-only') {
      options.touchedOnly = true
    } else if (flag === '--json') {
      options.json = true
    } else if (flag === '--limit') {
      index += 1
      const value = Number(argv[index])
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(`--limit needs a non-negative integer, got: ${argv[index] ?? '(nothing)'}`)
      }
      options.limit = value
    } else if (flag === '--help' || flag === '-h') {
      options.help = true
    } else if (flag.startsWith('-')) {
      throw new Error(`unknown argument: ${flag}`)
    } else if (options.range === null) {
      options.range = flag
    } else {
      throw new Error(`one range or revision expected, got two: ${options.range} and ${flag}`)
    }
  }
  return options
}

function usage() {
  console.log(`Usage: node local/sync/smoke-selector.mjs (<merge-revision> | <base>..<head>) [--dry-run] [--json] [--limit N]

Prints the unit tests a post-sync fork-surface smoke run should execute: the tests the fork-side
diff touches plus the tests coupled one import level away (branchCoupledPaths, from
local/gate-flake-coupling.mjs). A merge revision means merge-base(M^1,M^2)..M^1, with test files
and imports read at the merge commit; <base>..<head> is used as given, head as the tree.

Options:
  --touched-only  the diff's own test files, without the one-import-level coupling walk. Measured
              on merge 281cccf5a4: 886 files (≈14.8 test-minutes) against 4,459 with the walk
              (≈74.6), so the walk is not the cheap mode plan §6.1 assumed it was.
  --dry-run   audit report: selection with provenance, flat timing estimate (the plan §6.1 rate
              of ${SECONDS_PER_TEST_FILE.toFixed(2)} s/file), dropped files, and harness coupling
  --json      machine-readable report; never truncated
  --limit N   bound the --dry-run listing (default ${DEFAULT_LIMIT}; 0 = no bound). The plain
              listing is never truncated. Any bound is stated in the output.
  -h, --help  this text

Read-only. Exit 2 on usage errors, 1 when git fails; an empty selection is still exit 0.`)
}

function git(args) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024
  })
}

function gitZero(args) {
  return git([...args, '-z'])
    .split('\0')
    .filter(Boolean)
}

function short(sha) {
  return sha.slice(0, 10)
}

/** { base, head, tree, label } for a merge revision, a plain commit, or an explicit range. */
function resolveRange(spec) {
  const split = spec.indexOf('..')
  if (split !== -1) {
    const baseSpec = spec.slice(0, split)
    const headSpec = spec.slice(split + 2)
    if (baseSpec === '' || headSpec === '') {
      throw new Error(`both sides of the range are needed: ${spec}`)
    }
    const base = git(['rev-parse', '--verify', `${baseSpec}^{commit}`]).trim()
    const head = git(['rev-parse', '--verify', `${headSpec}^{commit}`]).trim()
    return { base, head, tree: head, label: `${short(base)}..${short(head)}` }
  }
  const rev = git(['rev-parse', '--verify', `${spec}^{commit}`]).trim()
  const parents = git(['rev-list', '--parents', '-n', '1', rev]).trim().split(/\s+/)
  if (parents.length >= 3) {
    const base = git(['merge-base', parents[1], parents[2]]).trim()
    return {
      base,
      head: parents[1],
      tree: rev,
      label: `${short(rev)} (merge; fork side ${short(base)}..${short(parents[1])})`
    }
  }
  if (parents.length === 2) {
    return {
      base: parents[1],
      head: rev,
      tree: rev,
      label: `${short(rev)} (commit; ${short(parents[1])}..${short(rev)})`
    }
  }
  return { base: EMPTY_TREE, head: rev, tree: rev, label: `${short(rev)} (root commit)` }
}

/**
 * `git cat-file --batch` contents for `<revision>:<path>`, in batches. A blob that resolves to
 * `missing` is served as an empty source rather than an error — the coupling walk then reports the
 * test as coupled only to itself, which is the honest answer for a path that is not there.
 */
async function fetchContents(revision, paths) {
  const contents = new Map()
  for (let start = 0; start < paths.length; start += BATCH) {
    const batch = paths.slice(start, start + BATCH)
    const child = spawn('git', ['cat-file', '--batch'], {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    const exited = new Promise((resolveExit, rejectExit) => {
      child.on('error', rejectExit)
      child.on('close', (code) =>
        code === 0
          ? resolveExit()
          : rejectExit(new Error(`git cat-file --batch exited ${code}: ${stderr.trim()}`))
      )
    })
    for (const path of batch) {
      child.stdin.write(`${revision}:${path}\n`)
    }
    child.stdin.end()
    const chunks = []
    for await (const chunk of child.stdout) {
      chunks.push(chunk)
    }
    const buffer = Buffer.concat(chunks)
    let offset = 0
    let index = 0
    while (index < batch.length) {
      const newline = buffer.indexOf(0x0a, offset)
      if (newline === -1) {
        break
      }
      const record = /^([0-9a-f]+) blob (\d+)$/.exec(buffer.subarray(offset, newline).toString())
      if (record === null) {
        offset = newline + 1
        continue
      }
      const bodyStart = newline + 1
      const size = Number(record[2])
      if (buffer.length < bodyStart + size + 1) {
        break
      }
      contents.set(batch[index], buffer.subarray(bodyStart, bodyStart + size).toString())
      index += 1
      offset = bodyStart + size + 1
    }
    await exited
  }
  return contents
}

function bounded(items, limit) {
  return limit === 0 || items.length <= limit
    ? { shown: items, truncated: 0 }
    : { shown: items.slice(0, limit), truncated: items.length - limit }
}

function tally(selected, key) {
  return selected.filter((entry) => entry.provenance === key).length
}

function report(selection, options) {
  const { range, diffFiles, candidates, selected, dropped, harness, treeTestFiles } = selection
  const touched = tally(selected, 'touched')
  const coupled = selected.length - touched
  const minutes = estimateSeconds(selected.length) / 60
  const diffTestCount = diffFiles.filter(isTestFile).length
  const lines = [
    `smoke selection — ${options.range}`,
    `  fork diff ${range.label}: ${diffFiles.length} files (${diffTestCount} test files)`,
    `  unit candidates at ${short(range.tree)}: ${candidates.length} of ${treeTestFiles.length} test-suffixed files (UNIT_INCLUDE minus UNIT_EXCLUDE)`,
    `  selected: ${selected.length} test files — ${touched} touched, ${coupled} coupled`,
    `  timing estimate: ${minutes.toFixed(1)} test-minutes at the plan §6.1 flat rate (${SECONDS_PER_TEST_FILE.toFixed(2)} s/file; 8.8 min over its 526-file baseline — an order-of-magnitude cost, not a prediction)`
  ]
  if (harness.length > 0) {
    lines.push(
      `  harness coupling: ${harness.join(', ')} — every unit test runs under these SHARED_TEST_INPUTS, so the smoke run does not cover them; AGENTS.md makes a diff touching them a full-gate change, and the selection deliberately does NOT expand to the whole suite`
    )
  } else {
    lines.push('  harness coupling: none — the fork diff touches no SHARED_TEST_INPUTS path')
  }
  if (dropped.length > 0) {
    const absent = dropped.filter((entry) => entry.reason === 'absent from the merged tree')
    const outside = dropped.filter((entry) => entry.reason !== 'absent from the merged tree')
    lines.push(`  dropped: ${dropped.length} touched test files the smoke run will not execute`)
    if (absent.length > 0) {
      lines.push(
        `    ${absent.length} absent from the merged tree (deleted or renamed by the merge)`
      )
      for (const entry of bounded(absent, options.limit).shown) {
        lines.push(`      ${entry.file}`)
      }
      if (absent.length > options.limit && options.limit > 0) {
        lines.push(`      … ${absent.length - options.limit} more (raise --limit or use --json)`)
      }
    }
    if (outside.length > 0) {
      lines.push(
        `    ${outside.length} in the merged tree but outside the unit suite (spec shape or UNIT_EXCLUDE)`
      )
      for (const entry of bounded(outside, options.limit).shown) {
        lines.push(`      ${entry.file}`)
      }
      if (outside.length > options.limit && options.limit > 0) {
        lines.push(`      … ${outside.length - options.limit} more (raise --limit or use --json)`)
      }
    }
  } else {
    lines.push('  dropped: none — every test file the fork diff touches is in the unit selection')
  }
  const listing = bounded(selected, options.dryRun ? options.limit : 0)
  lines.push(
    options.dryRun && listing.truncated > 0
      ? `  selection (showing ${listing.shown.length} of ${selected.length}; ${listing.truncated} not listed — raise --limit or use --json):`
      : `  selection (${selected.length}):`
  )
  for (const entry of listing.shown) {
    lines.push(
      entry.provenance === 'touched'
        ? `    touched ${entry.file}`
        : `    coupled ${entry.file}  <- ${entry.matched}`
    )
  }
  return lines.join('\n')
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`${error.message}\n`)
    usage()
    process.exit(2)
  }
  if (options.help) {
    usage()
    return
  }
  if (options.range === null) {
    console.error('a merge revision or <base>..<head> range is required\n')
    usage()
    process.exit(2)
  }
  let range
  try {
    range = resolveRange(options.range)
  } catch (error) {
    console.error(`${error.message}\n`)
    usage()
    process.exit(2)
  }
  const diffFiles = gitZero(['diff', '--name-only', range.base, range.head])
  const treePaths = gitZero(['ls-tree', '-r', '--name-only', range.tree])
  const candidates = unitCandidates(treePaths, UNIT_INCLUDE, UNIT_EXCLUDE)
  const treeTestFiles = treePaths.filter(isTestFile)
  const contents = await fetchContents(range.tree, candidates)
  const selected = selectSmokeTests({
    testFiles: candidates,
    diffFiles,
    readSource: (path) => contents.get(path) ?? '',
    coupledPaths: options.touchedOnly ? NO_COUPLING : undefined
  })
  const dropped = droppedTouchedTests({ diffFiles, candidates, treeTestFiles })
  const harness = harnessCoupling(diffFiles)
  const selection = { range, diffFiles, candidates, treeTestFiles, selected, dropped, harness }
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          range: { label: range.label, base: range.base, head: range.head, tree: range.tree },
          diffFileCount: diffFiles.length,
          unitCandidateCount: candidates.length,
          selected: selected.map((entry) => entry.file),
          provenance: Object.fromEntries(
            selected.map((entry) => [
              entry.file,
              { provenance: entry.provenance, matched: entry.matched }
            ])
          ),
          dropped,
          harness,
          estimate: {
            seconds: estimateSeconds(selected.length),
            secondsPerFile: SECONDS_PER_TEST_FILE
          }
        },
        null,
        2
      )
    )
    return
  }
  if (options.dryRun) {
    console.log(report(selection, options))
    return
  }
  if (harness.length > 0) {
    console.error(
      `note: the diff touches shared test harness paths (${harness.join(', ')}); this selection does not cover them — see --dry-run`
    )
  }
  if (dropped.length > 0) {
    console.error(
      `note: ${dropped.length} touched test files are not in this selection; see --dry-run`
    )
  }
  for (const entry of selected) {
    console.log(entry.file)
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
