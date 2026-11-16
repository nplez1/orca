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

/**
 * The stage-1/2/3 commits of the live operation, or null; a revert's sides are its target and its
 * parent. `rev(ref)` is a verified oid or null; `gitText(args, options)` is the caller's git runner.
 */
export function liveSides(rev, gitText) {
  const [merge, pick, rebase, revert] = [
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'REBASE_HEAD',
    'REVERT_HEAD'
  ].map(rev)
  const head = rev('HEAD')
  if (merge) {
    return {
      base: gitText(['merge-base', head, merge], { allowFailure: true }),
      ours: head,
      theirs: merge
    }
  }
  const replayed = pick ?? rebase
  if (replayed) {
    return { base: rev(`${replayed}^`), ours: head, theirs: replayed }
  }
  return revert ? { base: revert, ours: head, theirs: rev(`${revert}^`) } : null
}
