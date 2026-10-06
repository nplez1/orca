#!/usr/bin/env node
/**
 * Plan a curated, linear patch series for the fork's history.
 *
 * The series is a CONTIGUOUS partition of the existing line: each patch is the tree of a real
 * historical commit, so a series built from the plan ends byte-identical and nothing can change
 * behaviourally. `--plan` prints that partition, and planning is all this tool does.
 *
 * Applying a curation is a MANUAL, reviewed operation, deliberately not automated here: the old
 * `--apply` path force-moved `nplez1/curated` onto a rebuilt series, overwriting whatever branch
 * already had that name; the commit hooks can rewrite the trees it commits; the `local(...)`
 * commit-msg hook refuses commits outside `nplez1/main`; and the tree comparison it asserted only ran
 * after the fact. Read the plan, rebuild the series by hand, and keep the archive tag as the rollback
 * target.
 *
 * Folding is limited to `docs(fork)`, whose content is the bookkeeping of a previous sync or release.
 * `fix(sync)` is NOT bookkeeping — `0ca31372cc` restored authorization behaviour across 14 files — so
 * it is reported as its own bucket and never folded. `chore(staging)` stays excluded too: that prefix
 * has carried a 57-file dump of unrelated work.
 *
 * Why not run it every sync: measured on 2026-10-05, folding both `docs(fork)` and `fix(sync)` took
 * 148 patches to ~133; with `fix(sync)` no longer foldable the gain is smaller again. Fewer review
 * entries in exchange for a public rewrite is a bad trade until `docs(fork)` has accumulated. See
 * local/sync/README.md.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const HERE = import.meta.dirname
const REPO = join(HERE, '..', '..')
const LINE_SEP = '\u001f'
const REC_SEP = '\u001e'

// Bookkeeping-only commits, foldable into the neighbouring patch. `fix(sync)` is deliberately NOT
// here: that prefix has restored behaviour (0ca31372cc touched 14 files' authorization), so folding
// it would attribute a real fix to an unrelated patch.
const FOLDABLE = /^docs\(fork\):/
/** Its own bucket in the report, never folded. */
const FIX_SYNC = /^fix\(sync\):/

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 30, ...opts })
}

function usage() {
  console.log(`Usage:
  node local/sync/curate.mjs --plan [--range <rev-range>]        # default: print the plan
  node local/sync/curate.mjs --write-manifest [--range <range>]  # write local/sync/patch-series.json
  node local/sync/curate.mjs --help

The range defaults to "<upstream merge-base>..<current branch tip>". Every patch in the plan is a
contiguous group of commits, emitted as the tree of the group's LAST commit, so a series built from
the plan is identical to the current tip's. Applying a curation is a manual, reviewed operation:
this tool plans it and never builds a branch.`)
}

function parseArgs(argv) {
  const out = { mode: 'plan', range: null }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--help' || a === '-h') {
      return { help: true }
    } else if (a === '--plan') {
      out.mode = 'plan'
    } else if (a === '--write-manifest') {
      out.mode = 'manifest'
    } else if (a === '--range') {
      out.range = argv[++i]
    } else {
      console.error(`Unknown argument: ${a}`)
      process.exit(2)
    }
  }
  return out
}

function defaultRange() {
  const stateFile = join(HERE, 'state.json')
  if (existsSync(stateFile)) {
    try {
      const state = JSON.parse(readFileSync(stateFile, 'utf8'))
      if (state.oldBase && state.forkTip) {
        return `${state.oldBase}..${state.forkTip}`
      }
    } catch {
      /* fall through to the computed range */
    }
  }
  const tip = git(['rev-parse', 'HEAD']).trim()
  const base = git(['merge-base', 'HEAD', 'upstream/main']).trim()
  return `${base}..${tip}`
}

function readCommits(range) {
  const raw = git(['log', '--reverse', `--format=%H${LINE_SEP}%s${LINE_SEP}%b${REC_SEP}`, range])
  const commits = raw
    .split(REC_SEP)
    .filter((rec) => rec.trim())
    .map((rec) => {
      const [sha, subject, body] = rec.split(LINE_SEP)
      return { sha: sha.trim(), subject: (subject || '').trim(), body: (body || '').trim() }
    })
  for (const c of commits) {
    c.files = git(['show', '--name-only', '--format=', c.sha]).split('\n').filter(Boolean)
  }
  return commits
}

/** Group a run of foldable bookkeeping into the neighbouring group, otherwise one commit per group. */
function buildPlan(commits) {
  const groups = []
  let pending = null
  for (const commit of commits) {
    if (!pending) {
      pending = { members: [commit] }
      continue
    }
    if (FOLDABLE.test(commit.subject)) {
      // Attach to the group being built: that group's endpoint becomes this commit, whose tree
      // already contains both the work and its bookkeeping. Contiguity is what keeps the series
      // byte-identical.
      pending.members.push(commit)
      continue
    }
    groups.push(pending)
    pending = { members: [commit] }
  }
  if (pending) {
    groups.push(pending)
  }
  return groups.map((group) => {
    const last = group.members.at(-1)
    // The title comes from the work, not from the bookkeeping that followed it.
    const titled = group.members.find((c) => !FOLDABLE.test(c.subject)) ?? last
    return {
      endSha: last.sha,
      subject: titled.subject,
      members: group.members.map((c) => ({ sha: c.sha, subject: c.subject })),
      folded: group.members.filter((c) => c.sha !== titled.sha).map((c) => c.subject)
    }
  })
}

/** Files upstream changed in this sync range. A fork commit touching one of these can conflict. */
function upstreamChangedFiles(range) {
  try {
    return new Set(
      git(['diff', '--name-only', range.split('..')[0], 'upstream/main'])
        .split('\n')
        .filter(Boolean)
    )
  } catch {
    return null
  }
}

function printPlan(commits, groups, range) {
  const foldable = commits.filter((c) => FOLDABLE.test(c.subject))
  const fixSync = commits.filter((c) => FIX_SYNC.test(c.subject))
  const fixSyncFiles = new Set(fixSync.flatMap((c) => c.files))
  console.log(`commits in range: ${commits.length}`)
  console.log(`docs(fork) commits (foldable): ${foldable.length}`)
  // Reported, never folded: one fix(sync) commit can restore behaviour across a dozen files.
  console.log(
    `fix(sync) commits (never folded): ${fixSync.length}, touching ${fixSyncFiles.size} file(s)`
  )
  console.log(
    `curated patches: ${groups.length}  (was ${commits.length}, ${commits.length - groups.length} fewer)`
  )

  // The honest measure of a fold is not how many commits it removes but how many *conflict-capable*
  // ones: a bookkeeping commit that only touches fork-owned files (LOCAL-PATCHES.md, BRANCHES.md)
  // replays cleanly, so folding it buys nothing.
  const upstreamFiles = upstreamChangedFiles(range)
  if (upstreamFiles) {
    const byFile = (sha) => commits.find((c) => c.sha === sha)?.files ?? []
    const canConflict = (sha) => byFile(sha).some((f) => upstreamFiles.has(f))
    const folded = groups.flatMap((g) => g.members.slice(0, -1))
    const atRisk = folded.filter((m) => canConflict(m.sha))
    const totalRisk = commits.filter((c) => canConflict(c.sha)).length
    console.log(
      `folded commits that could conflict: ${atRisk.length} of ${folded.length} folded ` +
        `(the line carries ${totalRisk} conflict-capable commits in total)`
    )
    if (atRisk.length <= 2) {
      console.log(
        '=> not worth a rewrite: the fold removes at most a couple of conflict-capable commits.'
      )
    }
  } else {
    console.log('(upstream/main is unavailable, so the conflict-capable estimate was skipped)')
  }

  const interesting = groups.filter((g) => g.folded.length > 0)
  if (interesting.length > 0) {
    console.log('\ngroups that absorb docs(fork) bookkeeping:')
    for (const g of interesting) {
      console.log(`  ${g.subject}`)
      for (const f of g.folded) {
        console.log(`      += ${f}`)
      }
    }
  }
  console.log(`\nlast patch: ${groups.at(-1).subject}`)
}

function writeManifest(range, commits, groups) {
  const manifest = {
    generatedFrom: range,
    tip: commits.at(-1).sha,
    base: git(['rev-parse', `${range.split('..')[0]}`]).trim(),
    patchCount: groups.length,
    patches: groups.map((g) => ({ endSha: g.endSha, subject: g.subject, folded: g.folded }))
  }
  const path = join(HERE, 'patch-series.json')
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`wrote ${path} (${groups.length} patches)`)
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  usage()
  process.exit(0)
}
const range = args.range || defaultRange()
const commits = readCommits(range)
if (commits.length === 0) {
  console.error(`No commits in range ${range}`)
  process.exit(1)
}
const groups = buildPlan(commits)
printPlan(commits, groups, range)
if (args.mode === 'manifest') {
  writeManifest(range, commits, groups)
}
