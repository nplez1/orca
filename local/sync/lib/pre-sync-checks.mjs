// The pre-sync-only gates, plus the runbook's Step 0 mutations.
//
// Each gate returns `{ status, summary, details }` (see lib/checks.mjs for the shared ones); the
// driver owns the gate's title, its remediation text and its place in the report. Split out of
// pre-sync.mjs only so that file stays a readable driver — the gate logic is one body per gate.

import {
  STATUS,
  git,
  gitText,
  mergeTree,
  readSyncState,
  refExists,
  repoRoot,
  run,
  tailText,
  toolExists,
  toolPath,
  writeSyncState
} from './run.mjs'

export const FORK_BRANCH = 'nplez1/main'
export const LOCAL_FORK_REF = `refs/heads/${FORK_BRANCH}`
export const ORIGIN_FORK_REF = `refs/remotes/origin/${FORK_BRANCH}`
export const UPSTREAM_REF = 'refs/remotes/upstream/main'
export const ORIGIN_MAIN_REF = 'refs/remotes/origin/main'
export const BACKUP_REF = 'backup/nplez1-main-pre-sync'
// The release line merges; a feature branch or a `local(...)` series rebases (see the runbook's "Two
// shapes, one decision"). `pre-sync.mjs --rebase` selects the second procedure.
export const MERGE_COMMAND = `git checkout ${FORK_BRANCH} && git merge upstream/main`
export const REBASE_COMMAND = `git checkout ${FORK_BRANCH} && GIT_EDITOR=true git rebase upstream/main`
export const nextCommand = (rebase) => (rebase ? REBASE_COMMAND : MERGE_COMMAND)

function treeClean() {
  const status = git(['status', '--porcelain=v1'])
  if (!status.ok) {
    return { status: STATUS.failed, summary: 'git status failed', details: tailText(status.stderr) }
  }
  const entries = status.stdout.split('\n').filter(Boolean)
  const untracked = entries.filter((line) => line.startsWith('??')).length
  return {
    status: entries.length === 0 ? STATUS.passed : STATUS.failed,
    summary:
      entries.length === 0
        ? 'git status --porcelain is empty'
        : `${entries.length} entry(ies), ${untracked} untracked`,
    details: entries.slice(0, 20)
  }
}

function forkBranch() {
  const branch = gitText(['rev-parse', '--abbrev-ref', 'HEAD'])
  if (branch === null) {
    return { status: STATUS.failed, summary: 'HEAD could not be resolved', details: [] }
  }
  if (branch === FORK_BRANCH) {
    return {
      status: STATUS.passed,
      summary: `on ${FORK_BRANCH}, where the .husky/commit-msg hook allows them`,
      details: []
    }
  }
  // PR branches are cut from origin/main, so that range is the one that isolates them.
  const base = refExists(ORIGIN_MAIN_REF) ? 'origin/main' : 'upstream/main'
  const lines = (gitText(['log', '--format=%h %s', '--grep', '^local(', `${base}..HEAD`]) ?? '')
    .split('\n')
    .filter(Boolean)
  return {
    status: lines.length === 0 ? STATUS.passed : STATUS.failed,
    summary:
      lines.length === 0
        ? `on ${branch} (not the sync branch), but it carries no local(...) commits`
        : `on ${branch}, which carries ${lines.length} local(...) commit(s)`,
    details: lines
  }
}

function remotes() {
  const url = (name) => gitText(['remote', 'get-url', name])
  const origin = url('origin')
  const upstream = url('upstream')
  const problems = []
  if (!origin?.includes('nplez1/orca')) {
    problems.push(`origin must be nplez1/orca, is ${origin ?? 'missing'}`)
  }
  if (!upstream?.includes('stablyai/orca')) {
    problems.push(`upstream must be stablyai/orca, is ${upstream ?? 'missing'}`)
  }
  const short = (ref) => (refExists(ref) ? gitText(['rev-parse', '--short', ref]) : 'absent')
  return {
    status: problems.length === 0 ? STATUS.passed : STATUS.failed,
    summary:
      problems.length === 0 ? 'origin = fork, upstream = stablyai/orca' : problems.join('; '),
    details: [
      `branch: ${gitText(['rev-parse', '--abbrev-ref', 'HEAD']) ?? 'unknown'}`,
      `origin: ${origin ?? 'missing'}`,
      `upstream: ${upstream ?? 'missing'}`,
      `origin/main ref: ${short(ORIGIN_MAIN_REF)}`,
      `upstream/main ref: ${short(UPSTREAM_REF)}`
    ]
  }
}

// Records the three SHAs the sync needs and hands them to the later gates, so the dry run and
// --prepare never re-derive them (and cannot disagree with what the report printed).
//
// oldTip is the LOCAL tip of the release branch, never the remote's: the archive tag and the conflict
// dry run are about the commits this sync will move, and preferring the remote ref once left four
// unpushed local commits out of both. The branch's relationship to its upstream is reported
// explicitly instead of one side being chosen silently.
function syncShas(options) {
  const missing = [
    !refExists(LOCAL_FORK_REF) && LOCAL_FORK_REF,
    !refExists(UPSTREAM_REF) && UPSTREAM_REF
  ].filter(Boolean)
  if (missing.length > 0) {
    return { status: STATUS.failed, summary: `missing ref(s): ${missing.join(', ')}`, details: [] }
  }
  const oldTip = gitText(['rev-parse', LOCAL_FORK_REF])
  const newBase = gitText(['rev-parse', UPSTREAM_REF])
  const oldBase = gitText(['merge-base', LOCAL_FORK_REF, UPSTREAM_REF])
  if (oldBase === null) {
    return {
      status: STATUS.failed,
      summary: `no merge base between ${FORK_BRANCH} and ${UPSTREAM_REF}`,
      details: [
        'the fork line and upstream share no ancestor; check that both remotes are the right repos'
      ]
    }
  }
  const head = gitText(['rev-parse', 'HEAD'])
  const relation = forkUpstreamRelation()
  options.shas = { forkRef: LOCAL_FORK_REF, oldBase, oldTip, newBase, relation }
  const count = (range) => gitText(['rev-list', '--count', range]) ?? '?'
  // A branch behind its upstream (or diverged from it) must be reconciled first: the sync would
  // otherwise start from a tip that is missing commits the remote already has.
  const diverged = relation.verdict === 'behind' || relation.verdict === 'diverged'
  return {
    status: diverged ? STATUS.failed : STATUS.info,
    summary: `old base ${oldBase.slice(0, 10)}, old tip ${oldTip.slice(0, 10)} (local, ${relation.verdict}), new base ${newBase.slice(0, 10)}`,
    details: [
      `old base (merge-base ${FORK_BRANCH} ${UPSTREAM_REF}): ${oldBase}`,
      `old tip  (local ${FORK_BRANCH}): ${oldTip}`,
      head !== oldTip
        ? `HEAD: ${head} — not the local ${FORK_BRANCH} tip; the sync is recorded against ${FORK_BRANCH}`
        : null,
      `branch relationship: ${relation.verdict} — ${relation.detail}`,
      `new base (${UPSTREAM_REF}): ${newBase}`,
      `${count(`${oldBase}..${UPSTREAM_REF}`)} upstream commit(s) coming in, ${count(`${oldBase}..${LOCAL_FORK_REF}`)} fork commit(s) to replay`,
      `archive tag to take: archive/pre-sync-${oldTip.slice(0, 10)}`,
      `next step (${options.rebase ? 'rebase' : 'merge'}): ${nextCommand(options.rebase)}`,
      options.rebase
        ? null
        : 'a feature branch or a local(...) series rebases instead: rerun with --rebase for that procedure'
    ].filter(Boolean)
  }
}

/**
 * Explicit equal / ahead / behind / diverged verdict for the local release branch against
 * origin/<branch>. A branch that is behind or has diverged has to be reconciled before the sync
 * starts from it, so the gate fails rather than picking either side.
 */
function forkUpstreamRelation() {
  if (!refExists(ORIGIN_FORK_REF)) {
    return {
      verdict: 'unknown',
      detail: `${ORIGIN_FORK_REF} is absent — fetch the fork remote first`
    }
  }
  const counts = gitText([
    'rev-list',
    '--left-right',
    '--count',
    `${LOCAL_FORK_REF}...${ORIGIN_FORK_REF}`
  ])
  if (counts === null) {
    return { verdict: 'unknown', detail: `git rev-list --left-right --count failed` }
  }
  const [ahead, behind] = counts.split(/\s+/).map(Number)
  if (ahead === 0 && behind === 0) {
    return { verdict: 'equal', detail: `origin/${FORK_BRANCH} is at the same commit` }
  }
  if (behind === 0) {
    return { verdict: 'ahead', detail: `${ahead} local commit(s) not on origin/${FORK_BRANCH}` }
  }
  if (ahead === 0) {
    return {
      verdict: 'behind',
      detail: `${behind} commit(s) on origin/${FORK_BRANCH} are missing locally — fast-forward first`
    }
  }
  return {
    verdict: 'diverged',
    detail: `${ahead} local and ${behind} remote commit(s) differ — reconcile with origin/${FORK_BRANCH} first`
  }
}

function conflictDryRun(options) {
  if (!options.shas) {
    return {
      status: STATUS.unavailable,
      summary: 'no SHAs to compare, the ref lookup failed',
      details: []
    }
  }
  const { oldTip, newBase } = options.shas
  const dryRun = mergeTree(oldTip, newBase)
  if (dryRun.code !== 0 && dryRun.code !== 1) {
    return {
      status: STATUS.failed,
      summary: `git merge-tree exited ${dryRun.code ?? 'without running'}`,
      details: tailText(dryRun.stderr)
    }
  }
  if (dryRun.code === 1 && dryRun.files.length === 0) {
    return {
      status: STATUS.unavailable,
      summary: 'git merge-tree reported conflicts in a format this tool did not parse',
      details: []
    }
  }
  const details = dryRun.files.slice(0, 30)
  if (dryRun.files.length > 30) {
    details.push(`... ${dryRun.files.length - 30} more`)
  }
  if (toolExists('conflicts.mjs')) {
    // --summary is the runbook's spelling, but that tool treats --summary and --merge-tree as
    // mutually exclusive modes, so the bare dry run is the fallback rather than a missing check.
    const args = ['--merge-tree', oldTip, newBase]
    let classification = run('node', [toolPath('conflicts.mjs'), ...args, '--summary'], {
      cwd: repoRoot()
    })
    let invocation = '--merge-tree <a> <b> --summary'
    if (!classification.ok) {
      classification = run('node', [toolPath('conflicts.mjs'), ...args], { cwd: repoRoot() })
      invocation = '--merge-tree <a> <b> (this tool does not accept --summary with --merge-tree)'
    }
    const text = `${classification.stdout}${classification.stderr}`
    details.push(
      `class breakdown (conflicts.mjs ${invocation}, exit ${classification.code ?? 'did not run'}):`
    )
    const breakdown = text.split('\n').filter((line) => line.includes('conflicted path(s)'))
    if (breakdown.length === 0) {
      details.push(...tailText(text, 12).map((line) => `  ${line}`))
    } else {
      details.push(
        ...breakdown.map((line) => `  ${line}`),
        '  per-file classes: node local/sync/conflicts.mjs --merge-tree <old-tip> <upstream-tip>'
      )
    }
  } else {
    details.push('class breakdown: conflicts.mjs is not yet available in this repository')
  }
  return {
    status: STATUS.info,
    summary: `${dryRun.files.length} conflicted file(s) in a merge of old tip onto new base`,
    details
  }
}

// The runbook's manual Step 0 mutations. Idempotent by construction: every ref is checked before it
// is created and never moved, so a rerun cannot clobber the rollback target. A failure is returned in
// `failures` — the driver exits non-zero on it and never reports a printed failure as a pass — and a
// backup that has drifted off the pre-sync tip is reported rather than treated as a silent pass.
export function prepare(options, failedGates, rebase = false) {
  const messages = []
  const failures = []
  if (failedGates > 0) {
    return {
      messages: [`refused: ${failedGates} hard gate(s) failed, nothing was mutated`],
      failures,
      state: null
    }
  }
  const { forkRef, oldBase, oldTip, newBase, relation } = options.shas
  for (const [key, value] of [
    ['rerere.enabled', 'true'],
    ['merge.conflictStyle', 'zdiff3']
  ]) {
    const set = git(['config', key, value])
    const actual = gitText(['config', '--get', key])
    if (!set.ok || actual !== value) {
      failures.push(`git config ${key} ${value} failed (now ${actual ?? 'unset'})`)
    }
    messages.push(
      `git config ${key} ${value}: ${set.ok && actual === value ? 'set' : `FAILED (now ${actual ?? 'unset'})`}`
    )
  }
  const previous = readSyncState()
  if (previous.state?.oldTip && previous.state.oldTip !== oldTip) {
    messages.push(
      `state file recorded tip ${previous.state.oldTip.slice(0, 10)}; rewriting it for ${oldTip.slice(0, 10)}`
    )
  }
  const archiveTag = `archive/pre-sync-${oldTip.slice(0, 10)}`
  const wanted = [
    {
      ref: `refs/heads/${BACKUP_REF}`,
      kind: 'branch',
      label: BACKUP_REF,
      stale: "it does not point at the old tip, so it is not this sync's rollback target"
    },
    {
      ref: `refs/tags/${archiveTag}`,
      kind: 'tag',
      label: `tag ${archiveTag}`,
      stale: 'it points somewhere else'
    }
  ]
  for (const { ref, kind, label, stale } of wanted) {
    if (refExists(ref)) {
      const at = gitText(['rev-parse', `${ref}^{commit}`])
      const atTip = at === oldTip
      messages.push(
        `${label} already exists at ${(at ?? '?').slice(0, 10)} — left exactly as it is${atTip ? '' : ` (${stale})`}`
      )
      if (!atTip) {
        failures.push(
          `${label} is stale: ${(at ?? '?').slice(0, 10)} is not the pre-sync tip ${oldTip.slice(0, 10)} — move it or pick a new name before relying on it as the rollback target`
        )
      }
      continue
    }
    // One argv entry: `git branch a/b <sha>` and `git tag a/b <sha>` take a single ref name.
    const created = git([kind, ref.replace(/^refs\/(heads|tags)\//, ''), oldTip])
    if (created.ok) {
      messages.push(`created ${label} at ${oldTip.slice(0, 10)}`)
    } else {
      const reason = tailText(created.stderr, 3).join(' ')
      messages.push(`FAILED to create ${label}: ${reason}`)
      failures.push(`could not create ${label}: ${reason}`)
    }
  }
  const state = {
    tool: 'local/sync/pre-sync.mjs',
    writtenAt: new Date().toISOString(),
    branch: gitText(['rev-parse', '--abbrev-ref', 'HEAD']),
    forkRef,
    upstreamRef: UPSTREAM_REF,
    oldBase,
    oldTip,
    newBase,
    upstreamRelation: relation?.verdict ?? null,
    mode: rebase ? 'rebase' : 'merge',
    backupRef: BACKUP_REF,
    archiveTag,
    nextCommand: nextCommand(rebase)
  }
  messages.push(
    `wrote state file ${writeSyncState(state)} (under the git directory, so it is not tracked)`
  )
  messages.push(`next (${rebase ? 'rebase' : 'merge'}): ${nextCommand(rebase)}`)
  return { messages, failures, state }
}

export const preSyncGates = {
  treeClean,
  forkBranch,
  remotes,
  syncShas,
  conflictDryRun
}
