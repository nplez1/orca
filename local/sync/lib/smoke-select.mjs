// Pure selection core for `local/sync/smoke-selector.mjs` — no git, no fs, so every rule is
// unit-testable from fixtures (see smoke-select.test.mjs).
//
// The question §6.1 of the mergeability plan asks: after merging upstream, which unit tests would
// catch a fork patch the merge broke? The answer is the tests the fork-side diff
// (`merge-base..M^1`) touches, plus the tests coupled one import level away — the same coupling
// `local/gate-flake-coupling.mjs` already defines for flake waivers, reused here rather than
// re-derived, so the two cannot drift apart about what "coupled" means.
//
// Known limits, inherited from `branchCoupledPaths`: imports are followed one level, a workspace
// specifier (`@orca/…`) is skipped rather than guessed, and a string-built dynamic import is
// invisible to its regex. The timing number is flat — the plan's 8.8 test-minutes over its
// 526-file baseline is one aggregate, so every file is priced the same; it orders a smoke run
// against the full gate, it does not predict one file.
import { posix } from 'node:path'
import { branchCoupledPaths, sharedHarnessPaths } from '../../gate-flake-coupling.mjs'

export const TEST_FILE_SUFFIX = /\.(?:test|spec)\.[cm]?[jt]sx?$/

// Plan §6.1 measured 8.8 test-minutes over the 526-file timing baseline at merge 281cccf5a4.
export const SECONDS_PER_TEST_FILE = (8.8 * 60) / 526

export function isTestFile(file) {
  return TEST_FILE_SUFFIX.test(file)
}

/** The runnable unit suite over a repo-relative path list: UNIT_INCLUDE minus UNIT_EXCLUDE. */
export function unitCandidates(paths, include, exclude) {
  return paths
    .filter((file) => include.some((pattern) => posix.matchesGlob(file, pattern)))
    .filter((file) => !exclude.some((pattern) => posix.matchesGlob(file, pattern)))
    .sort()
}

/**
 * One test file's provenance, or null when nothing couples it to the diff. `coupled` is
 * `branchCoupledPaths`' own output order — the test file first, then its siblings, then its
 * one-level imports — so the first diff hit names the category without re-deriving it here.
 */
export function couplingProvenance(testFile, diffSet, coupled) {
  const matched = coupled.find((path) => diffSet.has(path))
  if (matched === undefined) {
    return null
  }
  return { file: testFile, provenance: matched === testFile ? 'touched' : 'coupled', matched }
}

export function selectSmokeTests({
  testFiles,
  diffFiles,
  readSource,
  coupledPaths = branchCoupledPaths
}) {
  const diffSet = new Set(diffFiles)
  const selected = []
  for (const file of testFiles) {
    const entry = couplingProvenance(file, diffSet, coupledPaths(file, readSource))
    if (entry !== null) {
      selected.push(entry)
    }
  }
  return selected.sort((left, right) => (left.file < right.file ? -1 : 1))
}

/**
 * Touched test files the smoke run cannot execute: absent from the merged tree (deleted or
 * renamed by the merge) or outside the unit suite (a spec shape no lane runs, or UNIT_EXCLUDE).
 * Reported, never silently dropped — the count is how a human checks the selector's arithmetic.
 */
export function droppedTouchedTests({ diffFiles, candidates, treeTestFiles }) {
  const candidateSet = new Set(candidates)
  const treeSet = new Set(treeTestFiles)
  return diffFiles
    .filter((file) => isTestFile(file) && !candidateSet.has(file))
    .map((file) => ({
      file,
      reason: treeSet.has(file)
        ? 'in the merged tree but outside the unit suite'
        : 'absent from the merged tree'
    }))
    .sort((left, right) => (left.file < right.file ? -1 : 1))
}

/**
 * `SHARED_TEST_INPUTS` the diff touches. Every unit test runs under these paths, so a match means
 * the smoke run's claim is weakened no matter how many tests it selects; the selector reports it
 * rather than expanding to the whole suite (§6.1 priced the smoke run without that expansion, and
 * AGENTS.md already makes such a diff a full-gate change).
 */
export function harnessCoupling(diffFiles, sharedPaths = sharedHarnessPaths()) {
  const diffSet = new Set(diffFiles)
  const exact = sharedPaths.filter((path) => !path.endsWith('/') && diffSet.has(path))
  const prefixes = sharedPaths.filter((path) => path.endsWith('/'))
  const rooted = diffFiles.filter((file) => prefixes.some((prefix) => file.startsWith(prefix)))
  return [...new Set([...exact, ...rooted])]
}

export function estimateSeconds(count) {
  return count * SECONDS_PER_TEST_FILE
}
