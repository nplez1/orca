// Running the reviewer over a packet's slices, in parallel, through the `claude` CLI.
//
// Why these flags. In the 2026-11-15 review four of six slices failed first time: in `-p` mode any
// tool call that would prompt is denied, and the reviewer's `awk`/`grep` pipelines over /tmp and its
// `git show --remerge-diff` all prompted. So the reviewer gets exactly the tools a read-only review
// needs, pre-approved (`--permission-mode dontAsk` denies the rest without a prompt to hang on), and
// the packet directory by `--add-dir`, because a linked worktree's git dir is outside its tree.
import { spawn } from 'node:child_process'
import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { REVIEWER } from '../pr-body-claims.mjs'
import { outputPaths, readReport } from './verdict.mjs'

const READ_ONLY_GIT = [
  'show',
  'log',
  'diff',
  'grep',
  'blame',
  'ls-tree',
  'ls-files',
  'cat-file',
  'rev-parse',
  'merge-base',
  'rev-list'
]
export const REVIEW_TOOLS = ['Read', 'Grep', 'Glob', 'Bash']
export const ALLOWED_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  ...READ_ONLY_GIT.map((command) => `Bash(git ${command}:*)`),
  'Bash(wc:*)',
  'Bash(head:*)',
  'Bash(tail:*)'
]

/**
 * The parent agent's session, which a reviewer launched from inside Claude Code would otherwise
 * inherit: its session id, its messaging socket and its effort level. The reviewer is its own
 * session, at `REVIEWER.thinking`, whoever launches it.
 */
const PARENT_SESSION_ENV =
  /^(?:CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_(?:SESSION_\w+|CHILD_SESSION|MESSAGING_\w+|ENTRYPOINT|EXECPATH))$/

export function reviewerEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !PARENT_SESSION_ENV.test(key)))
}

/** The CLI arguments for one slice. The prompt goes on stdin, so no argument is the prompt. */
export function reviewerArgs({ addDirs, maxBudgetUsd }) {
  // Why a refusal and not a fallback: AGENTS.md § PR gate 2 says to stop rather than substitute a
  // lookalike, and this runner only knows how to reach a `claude/*` reviewer.
  if (REVIEWER.provider !== 'claude') {
    throw new Error(
      `REVIEWER.provider is ${REVIEWER.provider}; this runner only drives the claude CLI`
    )
  }
  return [
    '-p',
    '--model',
    REVIEWER.alias,
    '--effort',
    REVIEWER.thinking,
    '--output-format',
    'json',
    '--no-session-persistence',
    '--permission-mode',
    'dontAsk',
    '--tools',
    REVIEW_TOOLS.join(','),
    // One argument per rule: `Bash(git show:*)` carries a space, so a joined list depends on how
    // the CLI splits it.
    '--allowedTools',
    ...ALLOWED_TOOLS,
    ...addDirs.flatMap((dir) => ['--add-dir', dir]),
    ...(maxBudgetUsd ? ['--max-budget-usd', String(maxBudgetUsd)] : [])
  ]
}

function runOne({ claude, args, cwd, dir, id, timeoutMs }) {
  const paths = outputPaths(dir, id)
  for (const path of [paths.out, paths.err, paths.run]) {
    rmSync(path, { force: true })
  }
  const prompt = readFileSync(paths.prompt, 'utf8')
  const out = openSync(paths.out, 'w')
  const err = openSync(paths.err, 'w')
  const startedAt = Date.now()
  return new Promise((resolve) => {
    let settled = false
    let timedOut = false
    let timer = null
    const finish = (record) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      closeSync(out)
      closeSync(err)
      // Why the run record is written last: its presence is what says "this slice ran", so a runner
      // killed mid-slice leaves no record and the slice reads as never run.
      const full = { ...record, timedOut, startedAt: new Date(startedAt).toISOString() }
      writeFileSync(
        paths.run,
        `${JSON.stringify({ ...full, durationMs: Date.now() - startedAt }, null, 2)}\n`
      )
      resolve(id)
    }
    const child = spawn(claude, args, { cwd, env: reviewerEnv(), stdio: ['pipe', out, err] })
    timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, timeoutMs)
    child.on('error', (error) => finish({ exitCode: null, signal: null, error: error.message }))
    child.on('close', (exitCode, signal) => finish({ exitCode, signal }))
    child.stdin.on('error', () => {})
    child.stdin.end(prompt)
  })
}

/**
 * Runs every slice that has no report yet, `concurrency` at a time. A slice that already reported
 * is never re-run: a re-run only spends money on what is missing.
 */
export async function runSlices({
  jobs,
  cwd,
  claude = 'claude',
  concurrency,
  timeoutMs,
  maxBudgetUsd,
  log = console.error
}) {
  const pending = jobs.filter((job) => readReport(job.dir, job.id).status !== 'reported')
  for (const job of jobs.filter((candidate) => !pending.includes(candidate))) {
    log(`  ${job.id}: already reported, not re-run`)
  }
  const queue = [...pending]
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      log(`  ${job.id}: started`)
      const args = reviewerArgs({ addDirs: job.addDirs, maxBudgetUsd })
      await runOne({ claude, args, cwd, dir: job.dir, id: job.id, timeoutMs })
      const report = readReport(job.dir, job.id)
      log(
        `  ${job.id}: ${report.status}${report.problem ? ` — ${report.problem}` : ''}${report.cost ? ` ($${report.cost.toFixed(2)})` : ''}`
      )
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker))
  return pending.map((job) => job.id)
}
