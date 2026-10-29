#!/usr/bin/env node
/**
 * Run the fork's two health checks and report them in one place.
 *
 * Both checks existed and neither ran anywhere: `local/check-actions-enablement.mjs` (nothing enabled
 * that should not be, nothing REQUIRED disabled) and `local/check-nightly-liveness.mjs` (the nightly
 * backstop is actually running and actually green). A check a human has to remember to run is a
 * comment, and the cost showed: a cache sweep stayed active from about 2026-10-25 and was found on
 * 10-28, after it had deleted 9.39 GB of `nplez1/main` caches, and one nightly issue sat open while
 * the last three runs were failure, success, success.
 *
 * `.github/workflows/fork-ci-health.yml` runs this daily. It opens one issue while either check is
 * unhappy, updates that same issue on every later run, and closes it when both are clean — so the
 * signal is a durable record with a state, not a log line nobody reads.
 *
 *   node local/ci-health-report.mjs               run both checks, open/update/close the issue
 *   node local/ci-health-report.mjs --dry-run     print the verdict and the action it would take
 *
 * Exit codes: 0 both clean, 1 attention needed (the run is red so the failure notifies), 2 could not
 * tell — which is not a pass either.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(import.meta.dirname, '..')
const REPO = 'nplez1/orca'

/** The checks, in the order the issue body lists them. */
export const CHECKS = [
  { name: 'check-actions-enablement', script: 'local/check-actions-enablement.mjs' },
  { name: 'check-nightly-liveness', script: 'local/check-nightly-liveness.mjs' }
]

/** One title, so every run finds the same issue instead of filing a new one each day. */
export const ISSUE_TITLE = 'Fork CI health: attention'
/** A findable marker, so a body edited by hand still reads as machine-owned. */
export const MARKER = '<!-- fork-ci-health -->'

const EXIT_MEANING = {
  0: 'clean',
  1: 'attention needed',
  2: 'could not tell'
}

/** Keep the issue readable: a check's output is quoted, but never unbounded. */
const TAIL_LINES = 40

function tail(text) {
  const lines = String(text ?? '')
    .trimEnd()
    .split('\n')
  return lines.length <= TAIL_LINES ? lines.join('\n') : lines.slice(-TAIL_LINES).join('\n')
}

/**
 * The verdict and the issue body, from results the caller already has, so this is testable without
 * a network or a `gh` binary.
 *
 * @param {{ name: string, code: number, output: string }[]} checks
 * @param {{ runUrl?: string | null }} [options]
 */
export function judgeHealth(checks, { runUrl = null } = {}) {
  const unknown = checks.filter((check) => check.code === 2)
  const failed = checks.filter((check) => check.code !== 0)
  const ok = failed.length === 0
  const lines = [
    MARKER,
    'Opened by `.github/workflows/fork-ci-health.yml`, which runs the two fork health checks daily',
    'and updates this one issue. Closed automatically when both are clean again.',
    '',
    '| check | result |',
    '|---|---|',
    ...checks.map(
      (check) => `| \`${check.name}\` | ${EXIT_MEANING[check.code] ?? `exit ${check.code}`} |`
    ),
    '',
    ...checks.flatMap((check) => [
      `### \`${check.name}\` — exit ${check.code}`,
      '',
      '```',
      tail(check.output) || '(no output)',
      '```',
      ''
    ])
  ]
  if (unknown.length > 0) {
    lines.push(
      '"Could not tell" is not a pass: the check never reached a verdict, so treat the missing answer',
      'as its own problem (no `gh`, no token, or no read access to the run history).',
      ''
    )
  }
  if (checks.some((check) => check.name === 'check-nightly-liveness' && check.code !== 0)) {
    lines.push(
      'A red nightly needs an owner: the first agent to open a session triages it, and either fixes it',
      'or files it. `node local/check-nightly-liveness.mjs --json` carries the facts, and',
      '`local/nightly-linux-known-red.json` is where a Linux-only red is classified with evidence.',
      ''
    )
  }
  if (typeof runUrl === 'string' && runUrl.length > 0) {
    lines.push(`Run: ${runUrl}`)
  }
  return {
    ok,
    title: ISSUE_TITLE,
    code: ok ? 0 : unknown.length === checks.length ? 2 : 1,
    body: lines.join('\n').trimEnd()
  }
}

/** What to do with the issue: no issue and nothing wrong is `none`, and so is a clean re-run. */
export function decideAction({ ok, issueNumber }) {
  if (ok) {
    return issueNumber ? 'close' : 'none'
  }
  return issueNumber ? 'update' : 'create'
}

function gh(args, options = {}) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options
  })
}

/** The open issue this tool owns, or null. Matched on the exact title it writes. */
export function findOpenIssue(listOutput) {
  const issues = JSON.parse(listOutput)
  return issues.find((issue) => issue.title === ISSUE_TITLE) ?? null
}

function runChecks() {
  return CHECKS.map((check) => {
    const result = spawnSync('node', [resolve(ROOT, check.script)], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024
    })
    return {
      name: check.name,
      code: result.status ?? 2,
      output: `${result.stdout ?? ''}${result.stderr ?? ''}`
    }
  })
}

/**
 * The lookup is a quoted phrase plus a local exact-title filter: unquoted, GitHub search reads
 * `health:` as a qualifier and stops matching, which would file a second issue every day.
 */
export function issueLookupArgs() {
  return [
    'issue',
    'list',
    '--repo',
    REPO,
    '--state',
    'open',
    '--search',
    `"${ISSUE_TITLE}" in:title`,
    '--json',
    'number,title',
    '--limit',
    '50'
  ]
}

function openIssue() {
  // Not caught: a lookup that failed is not "no issue". Reading it as one files a second issue on a
  // red day and closes nothing on a green one, so the caller exits 2 instead.
  return findOpenIssue(gh(issueLookupArgs()))
}

function writeBody(args, body) {
  gh(args, { input: body })
}

function main() {
  const dryRun = process.argv.includes('--dry-run')
  const runUrl =
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${REPO}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null

  const checks = runChecks()
  const verdict = judgeHealth(checks, { runUrl })

  let issue = null
  if (!dryRun) {
    try {
      issue = openIssue()
    } catch (error) {
      console.error(
        `ci-health: cannot tell which issue is ours: ${String(error.message).split('\n')[0]}`
      )
      process.exit(2)
    }
  }
  const action = decideAction({ ok: verdict.ok, issueNumber: issue?.number })

  console.error(`ci-health: ${verdict.ok ? 'both checks clean' : 'attention needed'} — ${action}`)

  if (dryRun) {
    console.log(verdict.body)
    process.exit(verdict.code)
  }

  try {
    if (action === 'create') {
      writeBody(
        ['issue', 'create', '--repo', REPO, '--title', ISSUE_TITLE, '--body-file', '-'],
        verdict.body
      )
      console.log(`ci-health: opened "${ISSUE_TITLE}"`)
    } else if (action === 'update') {
      writeBody(
        ['issue', 'edit', String(issue.number), '--repo', REPO, '--body-file', '-'],
        verdict.body
      )
      console.log(`ci-health: updated #${issue.number}`)
    } else if (action === 'close') {
      gh([
        'issue',
        'close',
        String(issue.number),
        '--repo',
        REPO,
        '--comment',
        'Both fork health checks are clean again.'
      ])
      console.log(`ci-health: closed #${issue.number}`)
    }
  } catch (error) {
    console.error(`ci-health: ${action} failed: ${String(error.message).split('\n')[0]}`)
    process.exit(2)
  }

  process.exit(verdict.code)
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main()
}
