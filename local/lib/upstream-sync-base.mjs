// The upstream commit this fork's sync is keyed to, and what that commit contains.
//
// Why a recorded SHA and not a ref: `origin` is this fork's own repository, so `origin/HEAD` resolves to
// `main` — the fork line, where every path exists and a rule about upstream ownership checks
// nothing. A ref tip is also the wrong answer, because it moves between syncs: upstream moved
// `ssh/connection/ssh-connection-store.ts` to `ssh/targets/` after the last sync, so a tip-based ruler
// reads two upstream-owned baseline rows as fork-owned. The record is the sync's own assertion, rewritten
// by the runbook's re-baseline step, and `local/check-upstream-file-comments.mjs` already falls back to it
// when no `upstream/main` is present — one record, not two.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

export const SYNC_BASE_RECORD = path.join('local', 'upstream-file-comments-baseline.json')

/** The recorded base, or `null` when the record is missing or carries no commit id. */
export function readRecordedSyncBase(root) {
  let record
  try {
    record = JSON.parse(readFileSync(path.join(root, SYNC_BASE_RECORD), 'utf8'))
  } catch {
    return null
  }
  const base = typeof record?.base === 'string' ? record.base.trim() : ''
  return /^[0-9a-f]{7,40}$/.test(base) ? base : null
}

function gitHasObject(root, object) {
  try {
    execFileSync('git', ['cat-file', '-e', object], {
      cwd: root,
      stdio: 'ignore'
    })
    return true
  } catch {
    return false
  }
}

/** Whether this clone carries the commit. False is "fetch it", not "the file is fork-owned". */
export function commitExists(root, commit) {
  return gitHasObject(root, `${commit}^{commit}`)
}

/** Whether the commit's tree carries `file`. A missing commit also answers false — check it first. */
export function commitHasPath(root, commit, file) {
  return gitHasObject(root, `${commit}:${file}`)
}

/** What a reader can paste to get the recorded base into this clone. */
export function fetchCommandFor(commit) {
  return `git fetch --depth=1 origin ${commit}`
}
