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
export const NEXT_COMMAND = `git checkout ${FORK_BRANCH} && git merge --ff-only origin/${FORK_BRANCH} && GIT_EDITOR=true git rebase upstream/main`

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
function syncShas(options) {
  const forkRef = refExists(ORIGIN_FORK_REF) ? ORIGIN_FORK_REF : LOCAL_FORK_REF
  const missing = [!refExists(forkRef) && forkRef, !refExists(UPSTREAM_REF) && UPSTREAM_REF].filter(
    Boolean
  )
  if (missing.length > 0) {
    return { status: STATUS.failed, summary: `missing ref(s): ${missing.join(', ')}`, details: [] }
  }
  const oldTip = gitText(['rev-parse', forkRef])
  const newBase = gitText(['rev-parse', UPSTREAM_REF])
  const oldBase = gitText(['merge-base', forkRef, UPSTREAM_REF])
  const localTip = refExists(LOCAL_FORK_REF) ? gitText(['rev-parse', LOCAL_FORK_REF]) : null
  options.shas = { forkRef, oldBase, oldTip, newBase, localTip }
  const count = (range) => gitText(['rev-list', '--count', range]) ?? '?'
  return {
    status: STATUS.info,
    summary: `old base ${oldBase.slice(0, 10)}, old tip ${oldTip.slice(0, 10)}, new base ${newBase.slice(0, 10)}`,
    details: [
      `old base (merge-base ${forkRef} ${UPSTREAM_REF}): ${oldBase}`,
      `old tip  (${forkRef}): ${oldTip}`,
      localTip && localTip !== oldTip
        ? `local ${FORK_BRANCH} tip: ${localTip} (does not match ${forkRef})`
        : null,
      `new base (${UPSTREAM_REF}): ${newBase}`,
      `${count(`${oldBase}..${UPSTREAM_REF}`)} upstream commit(s) coming in, ${count(`${oldBase}..${forkRef}`)} fork commit(s) to replay`,
      `archive tag to take: archive/pre-sync-${oldTip.slice(0, 10)}`
    ].filter(Boolean)
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

// The runbook's manual Step 0 mutations. Idempotent by construction: every ref is checked before
// it is created and never moved, so a rerun cannot clobber the rollback target.
export function prepare(options, failedGates) {
  const messages = []
  const failedConfig = []
  if (failedGates > 0) {
    return {
      messages: [`refused: ${failedGates} hard gate(s) failed, nothing was mutated`],
      failedConfig
    }
  }
  const { forkRef, oldBase, oldTip, newBase, localTip } = options.shas
  for (const [key, value] of [
    ['rerere.enabled', 'true'],
    ['merge.conflictStyle', 'zdiff3']
  ]) {
    const set = git(['config', key, value])
    const actual = gitText(['config', '--get', key])
    if (!set.ok || actual !== value) {
      failedConfig.push(key)
    }
    messages.push(
      `git config ${key} ${value}: ${set.ok && actual === value ? 'set' : `FAILED (now ${actual ?? 'unset'})`}`
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
      const atTip = gitText(['rev-parse', `${ref}^{commit}`]) === oldTip
      messages.push(
        `${label} already exists at ${gitText(['rev-parse', '--short', ref])} — left exactly as it is${atTip ? '' : ` (${stale})`}`
      )
      continue
    }
    // One argv entry: `git branch a/b <sha>` and `git tag a/b <sha>` take a single ref name.
    const created = git([kind, ref.replace(/^refs\/(heads|tags)\//, ''), oldTip])
    messages.push(
      created.ok
        ? `created ${label} at ${oldTip.slice(0, 10)}`
        : `FAILED to create ${label}: ${tailText(created.stderr, 3).join(' ')}`
    )
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
    localForkTip: localTip,
    backupRef: BACKUP_REF,
    archiveTag,
    nextCommand: NEXT_COMMAND
  }
  messages.push(
    `wrote state file ${writeSyncState(state)} (under the git directory, so it is not tracked)`
  )
  messages.push(`next: ${NEXT_COMMAND}`)
  return { messages, failedConfig, state }
}

export const preSyncGates = {
  treeClean,
  forkBranch,
  remotes,
  syncShas,
  conflictDryRun
}
