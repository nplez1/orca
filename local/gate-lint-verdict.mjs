#!/usr/bin/env node
/**
 * The lint gate's verdict, recorded the way the review gate records its own.
 *
 * Why this exists: `local/gate-lint.mjs` always runs every step and keeps no cache, so nothing could
 * answer the one question the release boundary needs — *did lint pass for this revision?* On the
 * 2026-11-24 release lint first ran 8.7 h after the merge, failed five steps, and the five repairs
 * landed after six review rounds; each repair then opened another review delta. A PASS marker keyed by
 * revision lets `--prepare` refuse until lint is green, and lets the dispatch boundary accept a commit
 * that is review-neutral on top of a gated one.
 *
 * The marker is only written for a full, clean (non-`--only`, non-dirty) PASS: a subset run says
 * nothing about the steps it skipped, and a dirty tree names no commit.
 *
 * The walk is the same rule `release-review-gate.mjs` applies to the review: a later commit that only
 * touches docs and review records does not void the verdict it follows. Importing that predicate
 * rather than restating it keeps the two gates from drifting apart.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Where markers live: beside `orca-review/` and `orca-gate/`, so one git dir holds all verdicts. */
export function lintVerdictDir(gitCommonDir) {
  return join(gitCommonDir, 'orca-lint')
}

export function lintMarkerPath(gitCommonDir, revision) {
  return join(lintVerdictDir(gitCommonDir), `${revision.slice(0, 12)}.json`)
}

/**
 * The revision and tree state a marker names, and the common git dir markers live under.
 *
 * Why the common dir and not the worktree's own git dir: a linked worktree answers the latter with
 * `.git/worktrees/<name>`, which would split the markers per worktree and re-gate one SHA twice —the
 * bug `gate-unit.mjs` documents around its cache dir.
 */
export function lintVerdictTarget(git) {
  return {
    revision: git(['rev-parse', '--short', 'HEAD']) ?? 'unknown',
    fullRevision: git(['rev-parse', 'HEAD']),
    dirty: Boolean(git(['status', '--porcelain'])),
    gitCommonDir: git(['rev-parse', '--path-format=absolute', '--git-common-dir'])
  }
}

/**
 * Record a full, clean run. `steps` is `[{ id, seconds, exitCode }]`; only the ids and the overall
 * outcome are kept, because the marker answers "did every step run green", not "what did it print".
 */
export function writeLintVerdict({ gitCommonDir, revision, steps, dirty = false, only = null }) {
  if (dirty || (only && only.length > 0) || !revision) {
    return null
  }
  const failed = steps.filter((step) => step.exitCode !== 0).map((step) => step.id)
  const marker = {
    revision,
    allPassed: failed.length === 0,
    failed,
    steps: steps.map((step) => step.id),
    recordedAt: new Date().toISOString()
  }
  const dir = lintVerdictDir(gitCommonDir)
  mkdirSync(dir, { recursive: true })
  writeFileSync(lintMarkerPath(gitCommonDir, revision), `${JSON.stringify(marker, null, 2)}\n`)
  return marker
}

export function readLintVerdict(gitCommonDir, revision) {
  const path = lintMarkerPath(gitCommonDir, revision)
  if (!existsSync(path)) {
    return null
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** Every revision that has a marker, newest first is the caller's job — this returns them unordered. */
export function lintVerdictRevisions(gitCommonDir) {
  const dir = lintVerdictDir(gitCommonDir)
  if (!existsSync(dir)) {
    return []
  }
  const revisions = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) {
      continue
    }
    try {
      const marker = JSON.parse(readFileSync(join(dir, name), 'utf8'))
      if (typeof marker.revision === 'string') {
        revisions.push(marker.revision)
      }
    } catch {
      // A damaged marker is a missing verdict, not a crash: the caller just runs lint again.
    }
  }
  return revisions
}

// Why the neutral walk is not here: deciding which revision's verdict still governs this one is a
// question about verdict caches, and `local/gate-verdict-cache.mjs` owns both the walk and the git
// readers it needs (`governingCachedVerdict`, `neutralReachable`). This module only records and reads
// the lint marker; one implementation of the rule serves the review, lint and unit gates alike.
