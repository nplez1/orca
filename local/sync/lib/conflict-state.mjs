// Which operation the worktree is stopped in, read from the git dir's state files. `--propose` records
// it in the decision and `--apply-proven` refuses a decision whose operation is not the live one.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export function readState(gitDir) {
  const info = (name) => {
    try {
      return readFileSync(join(gitDir, name), 'utf8').trim()
    } catch {
      return ''
    }
  }
  const rebase = ['rebase-merge', 'rebase-apply'].find((dir) => existsSync(join(gitDir, dir)))
  if (rebase) {
    const [step, total] = rebase === 'rebase-merge' ? ['msgnum', 'end'] : ['next', 'last']
    return {
      kind: 'rebase',
      step: Number(info(`${rebase}/${step}`) || 0),
      total: Number(info(`${rebase}/${total}`) || 0),
      branch: info(`${rebase}/head-name`).replace('refs/heads/', ''),
      onto: info(`${rebase}/onto`).slice(0, 10)
    }
  }
  for (const [file, kind] of [
    ['MERGE_HEAD', 'merge'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
    ['REVERT_HEAD', 'revert']
  ]) {
    if (existsSync(join(gitDir, file))) {
      const head = info(file).split('\n')[0].trim().slice(0, 10)
      return { kind, head, subject: info('MERGE_MSG').split('\n')[0] }
    }
  }
  return { kind: 'none' }
}

// The ref that holds the replayed (or reverted) commit for each operation `readState` names.
const OPERATION_HEAD = {
  merge: 'MERGE_HEAD',
  'cherry-pick': 'CHERRY_PICK_HEAD',
  rebase: 'REBASE_HEAD',
  revert: 'REVERT_HEAD'
}

/**
 * The stage-1/2/3 commits of the operation `state` (readState's) names, or null. Derived from its kind,
 * not from whichever *_HEAD ref a finished operation left behind. A merge with more than one merge base
 * has a virtual base no commit holds, and a revert's sides are its target and its target's parent.
 * `rev(ref)` is a verified oid or null; `gitText(args, options)` is the caller's git runner.
 */
export function liveSides(state, rev, gitText) {
  const head = rev('HEAD')
  const operation = OPERATION_HEAD[state?.kind] ? rev(OPERATION_HEAD[state.kind]) : null
  if (!head || !operation) {
    return null
  }
  if (state.kind === 'merge') {
    const base = singleMergeBase(gitText, head, operation)
    return base ? { base, ours: head, theirs: operation } : null
  }
  if (state.kind === 'revert') {
    return { base: operation, ours: head, theirs: rev(`${operation}^`) }
  }
  return { base: rev(`${operation}^`), ours: head, theirs: operation }
}

/** The one merge base of two commits, or null: a criss-cross merge's virtual base no commit holds. */
export function singleMergeBase(gitText, left, right) {
  const bases = (gitText(['merge-base', '--all', left, right], { allowFailure: true }) ?? '')
    .split('\n')
    .filter(Boolean)
  return bases.length === 1 ? bases[0] : null
}
