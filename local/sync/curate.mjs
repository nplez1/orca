#!/usr/bin/env node
/**
 * Rebuild the fork's history as a curated, linear patch series.
 *
 * The series is a CONTIGUOUS partition of the existing line: each patch is emitted as the tree of a
 * real historical commit, so the final tree is byte-identical and nothing can change behaviourally.
 * That is the whole safety argument, and `--plan`/`--apply` both assert it.
 *
 * It is opt-in and deliberately conservative:
 *  - `--plan` (default) prints what it would do and touches nothing.
 *  - `--apply` builds a NEW branch (`nplez1/curated`) from a clean tree. It never force-updates
 *    `nplez1/main`, because rewriting the release line is a decision, not a side effect.
 *
 * Why not run it every sync: measured on 2026-10-05, folding the scaffolding took 148 patches to
 * ~133. Fifteen fewer review entries in exchange for a public rewrite is a bad trade until the
 * scaffolding has accumulated again. See local/sync/README.md.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const HERE = import.meta.dirname
const REPO = join(HERE, '..', '..')
const LINE_SEP = '\u001f'
const REC_SEP = '\u001e'

// Scaffolding: commits whose only content is the bookkeeping of a previous sync or release.
// `chore(staging)` is deliberately NOT here: that prefix has carried a 57-file dump of unrelated
// work, so folding it into a neighbouring patch would attribute someone else's change.
const SCAFFOLDING = /^(docs\(fork\)|fix\(sync\)):/

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 30, ...opts })
}

function usage() {
  console.log(`Usage:
  node local/sync/curate.mjs --plan [--range <rev-range>]        # default: print the plan
  node local/sync/curate.mjs --write-manifest [--range <range>]  # write local/sync/patch-series.json
  node local/sync/curate.mjs --apply [--range <range>]           # build nplez1/curated (clean tree only)
  node local/sync/curate.mjs --help

The range defaults to "<upstream merge-base>..<current branch tip>". Every patch in the plan is a
contiguous group of commits, emitted as the tree of the group's LAST commit, so the final tree is
identical to the current tip's.`)
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
    } else if (a === '--apply') {
      out.mode = 'apply'
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

/** Group a run of scaffolding into the neighbouring group, otherwise one commit per group. */
function buildPlan(commits) {
  const groups = []
  let pending = null
  for (const commit of commits) {
    const isScaffold = SCAFFOLDING.test(commit.subject)
    if (!pending) {
      pending = { members: [commit], scaffoldingOnly: isScaffold }
      continue
    }
    if (isScaffold) {
      // Attach to the group being built: that group's endpoint becomes this commit, whose tree
      // already contains both the work and its bookkeeping. Contiguity is what keeps the final
      // tree byte-identical.
      pending.members.push(commit)
      pending.scaffoldingOnly = pending.scaffoldingOnly && true
      continue
    }
    if (isScaffold) {
      pending.members.push(commit)
      pending.scaffoldingOnly = true
      continue
    }
    groups.push(pending)
    pending = { members: [commit], scaffoldingOnly: false }
  }
  if (pending) {
    groups.push(pending)
  }
  return groups.map((group) => {
    const last = group.members.at(-1)
    // The title comes from the work, not from the bookkeeping that followed it.
    const titled = group.members.find((c) => !SCAFFOLDING.test(c.subject)) ?? last
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
  const foldedCount = commits.filter((c) => SCAFFOLDING.test(c.subject)).length
  console.log(`commits in range: ${commits.length}`)
  console.log(`scaffolding commits: ${foldedCount}`)
  console.log(
    `curated patches: ${groups.length}  (was ${commits.length}, ${commits.length - groups.length} fewer)`
  )

  // The honest measure of a fold is not how many commits it removes but how many *conflict-capable*
  // ones: a scaffolding commit that only touches fork-owned files (LOCAL-PATCHES.md, BRANCHES.md)
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
    console.log('\ngroups that absorb scaffolding:')
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

function applyPlan(groups) {
  const branch = 'nplez1/curated'
  const dirty = git(['status', '--porcelain']).trim()
  if (dirty) {
    console.error(
      'Refusing to run: the working tree is not clean. History surgery can destroy edits.'
    )
    console.error(dirty)
    process.exit(1)
  }
  const tip = git(['rev-parse', 'HEAD']).trim()
  const short = tip.slice(0, 9)
  const archive = `archive/pre-curation-${short}`
  if (git(['tag', '--list', archive]).trim() === '') {
    git(['tag', archive, tip])
    console.log(`archived the current tip as ${archive}`)
  } else {
    console.log(`archive tag ${archive} already exists; leaving it as it is`)
  }
  // Start from the range's base, not its first commit: the first patch's tree is emitted as a
  // commit on top of the base, which is what reproduces the series.
  const base = git(['rev-parse', groups[0].members[0].sha]).trim()
  git(['checkout', '-B', branch, `${base}^`])
  for (const group of groups) {
    // read-tree sets index+worktree to that real historical tree; the commit then carries it.
    git(['read-tree', '-u', '--reset', group.endSha])
    const body =
      group.folded.length > 0 ? `\n\nFolded by curation: ${group.folded.join(' | ')}` : ''
    git(['commit', '-q', '--allow-empty', '-m', `${group.subject}${body}`])
  }
  const newTip = git(['rev-parse', 'HEAD']).trim()
  const diff = git(['diff', '--stat', tip, newTip]).trim()
  if (diff) {
    console.error(`!! trees differ — do NOT push ${branch}:`)
    console.error(diff)
    process.exit(1)
  }
  console.log(`\n${branch} built: ${groups.length} patches, tree identical to ${tip}`)
  console.log('Review it, then move the release line yourself if you want it.')
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
if (args.mode === 'apply' && SCAFFOLDING.test(commits.at(-1).subject) === false) {
  // Not an error, just a note: the tip is usually a product commit on this fork.
}
const groups = buildPlan(commits)
printPlan(commits, groups, range)
if (args.mode === 'manifest') {
  writeManifest(range, commits, groups)
}
if (args.mode === 'apply') {
  applyPlan(groups)
}
