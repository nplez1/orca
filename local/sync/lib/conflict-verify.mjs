// --verify: exit 1 if any unmerged path or conflict-marker line remains. A scan that could not run is
// never a clean tree, so every failure path prints the command's own error instead of passing quietly.

import { unmergedPaths } from './conflict-progress.mjs'

// Labelled markers only: a bare `=======` line is a diff separator in .patch files and a rule in
// licence text, both of which this repo tracks.
const MARKER_PATTERN = '^(<<<<<<<|\\|\\|\\|\\|\\|\\|\\|) |^>>>>>>> '

function verifyFailed(what, stderr, maxLines = 10) {
  console.log(`verify: FAIL — ${what}`)
  const lines = String(stderr ?? '')
    .trimEnd()
    .split('\n')
    .filter((line) => line !== '')
  for (const line of lines.slice(0, maxLines)) {
    console.log(`  ${line}`)
  }
  if (lines.length > maxLines) {
    console.log(`  ... ${lines.length - maxLines} more line(s)`)
  }
  return 1
}

export function runVerify({ git, gitText }) {
  let paths
  try {
    paths = unmergedPaths(gitText)
  } catch (error) {
    return verifyFailed(
      'the unmerged-path scan (git diff --diff-filter=U) could not run',
      error.message
    )
  }
  const grep = git(['grep', '-I', '-l', '-E', MARKER_PATTERN, '--', '.'])
  if (grep.error) {
    return verifyFailed('git grep could not be spawned', grep.error.message ?? grep.error)
  }
  // git grep exits 1 for "no match", which is the pass case; any other non-zero status is the scan
  // itself failing, and reporting that as clean would hide the files it never read.
  if (grep.status !== 0 && grep.status !== 1) {
    return verifyFailed(
      `the conflict-marker scan could not run (git grep exit ${grep.status})`,
      (grep.stderr ?? '') + (grep.stdout ?? '')
    )
  }
  const markers = (grep.stdout ?? '').split('\n').filter(Boolean)
  const rows = []
  if (paths.length > 0) {
    rows.push(`${paths.length} unmerged path(s) in the index: ${paths.join(', ')}`)
  }
  if (markers.length > 0) {
    rows.push(
      `${markers.length} worktree file(s) still contain conflict-marker lines: ${markers.join(', ')}`
    )
  }
  if (rows.length === 0) {
    console.log(
      'verify: clean — no unmerged paths, no conflict-marker lines in tracked worktree files'
    )
    return 0
  }
  console.log('verify: conflicts remain —')
  for (const row of rows) {
    console.log(`  ${row}`)
  }
  return 1
}
