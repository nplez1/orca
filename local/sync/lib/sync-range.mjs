// Which two commits this sync is made of. Split out of post-sync-checks.mjs when that file reached the
// repo's max-lines budget: the range is the input every check shares, so it has one home.
//
// Both refs are checked against HEAD before they are believed. `pre-sync.mjs --prepare` writes the state
// file and the backup ref, but a sync prepared by hand from the runbook, or a post-sync run from another
// worktree, can leave either one pointing at a commit from a different sync. Either ref on its own then
// scans the wrong range and reports a pass, which is worse than reporting nothing.

import { STATUS, gitText, readSyncState, refExists, shortCommit as short } from './run.mjs'

export const UPSTREAM_REF = 'upstream/main'
export const BACKUP_REF = 'backup/nplez1-main-pre-sync'

/**
 * The one failed outcome for "this sync's tip belongs to some other sync". Shared rather than copied:
 * four checks refuse for exactly this reason, and a message that drifts between them is how one of them
 * quietly starts reporting a pass again.
 */
export function foreignTipFailure(problem, detail) {
  return {
    status: STATUS.failed,
    summary: `the pre-sync tip does not belong to this sync: ${String(problem)}`,
    details: [
      detail,
      're-run `node local/sync/pre-sync.mjs --prepare` before relying on this check'
    ]
  }
}

/**
 * The two commits a merge of this sync must be built from: HEAD's own parents, or HEAD and MERGE_HEAD
 * while the merge is still in progress. `null` when HEAD is not a merge, which is the rebase shape.
 */
export function mergePair() {
  const head = gitText(['rev-parse', '--verify', '--quiet', 'HEAD'])
  const mergeHead = gitText(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])
  if (mergeHead) {
    return head === null ? null : { tip: head, base: mergeHead, midMerge: true }
  }
  const row = gitText(['rev-list', '--parents', '-n', '1', 'HEAD'])
  const parts = row ? row.split(' ').filter(Boolean) : []
  return parts.length >= 3 ? { tip: parts[1], base: parts[2], midMerge: false } : null
}

// A recorded tip or base that is not in HEAD's history cannot belong to this sync, however HEAD is shaped.
// The merge-parent check catches the common case; this catches a fixup commit on top, where HEAD is no
// longer a merge and the parent comparison has nothing to compare against.
const inHistory = (commit) => gitText(['merge-base', '--is-ancestor', commit, 'HEAD']) !== null

/**
 * Whether the ancestry test can be applied at all. A REBASE rewrites the branch, so its pre-sync tip is
 * deliberately not in the rebased HEAD's history and the test would refuse every rebase sync — the shape
 * the runbook's `--rebase` procedure produces. The state file records that shape; with no state file there
 * is nothing to associate the ref with either, so only a merge-shaped sync is checked.
 */
const ancestryApplies = (state) => state?.mode !== 'rebase'

/**
 * The pre-sync tip, which is what "ours" means for every check that compares a range. The state file is
 * written by `pre-sync.mjs --prepare`; the backup ref covers a sync prepared by hand from the runbook.
 * Neither is accepted on its own: when HEAD is a merge, the tip has to be its first parent.
 */
export function resolvePreSyncTip() {
  const pair = mergePair()
  const { state, source, file } = readSyncState()
  if (state?.oldTip && refExists(`${state.oldTip}^{commit}`)) {
    const tip = gitText(['rev-parse', `${state.oldTip}^{commit}`]) ?? state.oldTip
    if (pair !== null && tip !== pair.tip) {
      return {
        tip: null,
        source: null,
        problem: `${source} (${file}) names ${short(tip)} as the pre-sync tip, but this is a merge of ${short(pair.tip)} and ${short(pair.base)}: the state file does not belong to this merge`
      }
    }
    if (pair === null && ancestryApplies(state) && !inHistory(tip)) {
      return {
        tip: null,
        source: null,
        problem: `${source} (${file}) names ${short(tip)} as the pre-sync tip, which is not in HEAD's history: the state file belongs to another sync`
      }
    }
    return { tip, source: `${source} (${file})`, problem: null }
  }
  const backup = gitText(['rev-parse', '--verify', '--quiet', `refs/heads/${BACKUP_REF}`])
  if (!backup) {
    return { tip: null, source: null, problem: null }
  }
  if (pair !== null && backup !== pair.tip) {
    return {
      tip: null,
      source: null,
      problem: `ref ${BACKUP_REF} is at ${short(backup)}, not at HEAD's first parent ${short(pair.tip)}: it is not this merge's rollback target, so the range it defines is the wrong one`
    }
  }
  if (pair === null && ancestryApplies(readSyncState().state) && !inHistory(backup)) {
    return {
      tip: null,
      source: null,
      problem: `ref ${BACKUP_REF} is at ${short(backup)}, which is not in HEAD's history: it is another sync's rollback target`
    }
  }
  return { tip: backup, source: `ref ${BACKUP_REF}`, problem: null }
}

/**
 * The upstream base this sync recorded, i.e. `pre-sync.mjs --prepare`'s newBase. The red-flag scan must
 * not compare against the moving `upstream/main`: upstream keeps advancing after the sync, and the set of
 * files it "touched in this range" would change under the check. The recorded base is checked the same
 * way the tip is: on a merge, `newBase` has to be HEAD's second parent.
 *
 * With no state file the merge itself still names the base (`HEAD^2`), so it is read from there rather
 * than derived. `merge-base(HEAD, upstream/main)` is the remaining case — a rebase sync, where HEAD is
 * not a merge. Deriving it from the pre-sync tip instead yields the PREVIOUS sync's base and collapses
 * the upstream range to nothing.
 */
export function pinnedUpstreamBase(tip, source) {
  const pair = mergePair()
  const { state, source: stateSource, file } = readSyncState()
  if (state?.newBase) {
    const resolved = gitText(['rev-parse', '--verify', '--quiet', `${state.newBase}^{commit}`])
    if (!resolved) {
      return {
        base: null,
        source: null,
        problem: `the state file records new base ${state.newBase}, which does not resolve to a commit`
      }
    }
    if (pair !== null && resolved !== pair.base) {
      return {
        base: null,
        source: null,
        problem: `${stateSource} (${file}) records new base ${short(resolved)}, but this is a merge of ${short(pair.tip)} and ${short(pair.base)}: the state file does not belong to this merge`
      }
    }
    if (pair === null && ancestryApplies(state) && !inHistory(resolved)) {
      return {
        base: null,
        source: null,
        problem: `${stateSource} (${file}) records new base ${short(resolved)}, which is not in HEAD's history: the state file belongs to another sync`
      }
    }
    return { base: resolved, source: `${stateSource} (${file})` }
  }
  if (pair !== null) {
    return {
      base: pair.base,
      source: `HEAD^2 of the merge${source ? ` (no state file; tip from ${source})` : ''}`
    }
  }
  const derived = gitText(['merge-base', 'HEAD', UPSTREAM_REF])
  return derived
    ? {
        base: derived,
        source: `merge-base(HEAD, ${UPSTREAM_REF}) (no state file${source ? `; tip from ${source}` : ''})`
      }
    : {
        base: null,
        source: null,
        problem: `no recorded base: no state file, and no merge base between HEAD and ${UPSTREAM_REF}`
      }
}
