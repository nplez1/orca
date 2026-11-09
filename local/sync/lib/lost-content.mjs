// The lost-content red-flag scan: a modified file upstream never touched in this sync's range means the
// replay moved content it did not own.
//
// Why its own module: it is the one check whose verdict is a pointer rather than a gate — the merge's
// own resolutions legitimately touch such files — so it reads differently from the rest and belongs
// with its own reasoning. Split out of post-sync-checks.mjs, which keeps the row's public surface.

import { BACKUP_REF, foreignTipFailure, pinnedUpstreamBase } from './sync-range.mjs'
import { STATUS, changedNames, git, gitText } from './run.mjs'

// Runbook Step 3.1, the check that catches the dropped-merge-commit trap: a MODIFIED file that
// upstream never touched in this sync's range means the replay moved content it did not own. A path
// upstream does not have at all is fork-only by construction, and expected here. This is a red-flag
// scan over modified files — it does not prove that no content was lost anywhere else.
export function lostContent(tip, source, problem = null) {
  if (problem !== null) {
    return foreignTipFailure(
      problem,
      'the scan would compare the wrong range and report clean, so it refuses instead'
    )
  }
  if (!tip) {
    return {
      status: STATUS.unavailable,
      summary: `no pre-sync tip: ${BACKUP_REF} is absent and no state file names one`,
      details: []
    }
  }
  const pinned = pinnedUpstreamBase(tip, source)
  if (pinned.base === null) {
    return {
      status: STATUS.failed,
      summary: `cannot pin the upstream base: ${pinned.problem}`,
      details: [
        'the scan compares against the base pre-sync recorded; without it the answer is unknown, not clean'
      ]
    }
  }
  const base = pinned.base
  const oldBase = gitText(['merge-base', tip, base])
  if (!oldBase) {
    return {
      status: STATUS.failed,
      summary: `no merge base between ${tip.slice(0, 10)} and the pinned base ${base.slice(0, 10)}`,
      details: []
    }
  }
  const upstreamChanged = changedNames([oldBase, base])
  const modified = changedNames(['--diff-filter=M', tip, 'HEAD'])
  // A failed diff has to read as a failed check: an empty result set looks exactly like "nothing
  // modified here", which is the clean answer this scan must not invent.
  if (upstreamChanged === null || modified === null) {
    const range =
      upstreamChanged === null
        ? `${oldBase.slice(0, 10)}..${base.slice(0, 10)}`
        : `${tip.slice(0, 10)}..HEAD`
    return {
      status: STATUS.failed,
      summary: `git diff --name-only failed for ${range}`,
      details: ['the modified/upstream-touched sets are unknown, so the scan cannot report clean']
    }
  }
  const upstreamFiles = new Set(upstreamChanged)
  const redFlags = []
  const forkOnly = []
  for (const file of modified.filter((name) => !upstreamFiles.has(name))) {
    // The pinned base resolves, so a cat-file miss means the path is absent there (fork-only
    // by construction), not that the probe failed.
    if (git(['cat-file', '-e', `${base}:${file}`]).ok) {
      redFlags.push(file)
    } else {
      forkOnly.push(file)
    }
  }
  return {
    // A review pointer, not a verdict. The runbook calls a modified file upstream never touched a
    // "red flag", and it is one — the merge's own resolutions legitimately touch such files (a
    // barrel re-point after an extraction, for instance), so failing here would make this gate
    // permanently red and therefore ignored. Deletions, which can be proven unreferenced, still
    // fail; this lists what a reviewer should look at.
    status: STATUS.info,
    summary:
      redFlags.length === 0
        ? `red-flag scan clear (modified files only); ${forkOnly.length} fork-only file(s) listed below`
        : `${redFlags.length} modified file(s) upstream never touched in this range — review them, not proven lost`,
    details: [
      `pre-sync tip: ${tip.slice(0, 10)} from ${source}`,
      `pinned upstream base: ${base.slice(0, 10)} from ${pinned.source}`,
      `old base (merge-base of that tip and the pinned base): ${oldBase.slice(0, 10)}`,
      `${modified.length} file(s) modified here, ${upstreamFiles.size} file(s) upstream touched`,
      `red flags (the pinned base knows the path but upstream did not touch it in this range): ${redFlags.length}`,
      ...(redFlags.length === 0 ? [] : redFlags.slice(0, 30).map((file) => `  ! ${file}`)),
      `fork-only by construction (path absent at the pinned base), expected here: ${forkOnly.length}`,
      ...forkOnly.slice(0, 30).map((file) => `  - ${file}`)
    ]
  }
}
