#!/usr/bin/env node
/**
 * Run the fork's health checks and report them in one place.
 *
 * The first two existed and neither ran anywhere: `local/check-actions-enablement.mjs` (nothing
 * enabled that should not be, nothing REQUIRED disabled) and `local/check-nightly-liveness.mjs` (the
 * nightly backstop is actually running and actually green). A check a human has to remember to run is
 * a comment, and the cost showed: a cache sweep stayed active from about 2026-10-25 and was found on
 * 10-28, after it had deleted 9.39 GB of `main` caches, and one nightly issue sat open while
 * the last three runs were failure, success, success.
 *
 * `local/check-queued-runs.mjs` is the third, and it covers what `timeout-minutes` cannot: a job whose
 * runner label nothing provisions waits for GitHub's 24 h limit rather than its own timeout, and the
 * run it sits in still reads `in_progress`. That is the 2026-10-26 `relay_integration` wait (17.5 h)
 * and the 2026-10-28 cache producer (12 h).
 *
 * `.github/workflows/fork-ci-health.yml` runs this daily. It opens one issue while any check is
 * unhappy, updates that same issue on every later run, and closes it when all of them are clean — so
 * the signal is a durable record with a state, not a log line nobody reads.
 *
 * A red issue also carries `agent:auto`, which hands it to the autonomous pipeline in
 * `~/Code/homelab/agent-driver` instead of waiting for a human to triage it. Two things make that
 * narrower than it looks, and both are load-bearing:
 *
 *   - the label is applied with a token whose actor is a collaborator, never with `GITHUB_TOKEN`.
 *     `driver.py::_labeler_permission` refuses a `[bot]` actor outright — "an agent holding a token
 *     must not be able to queue work for itself" — so a workflow-token label is skipped every tick.
 *   - an allowlisted known-red class never reaches this issue at all. A shard job only fails when
 *     its red matches nothing in `local/nightly-linux-known-red.json`
 *     (`local/check-unit-shard-verdict.mjs`), so the classes `AGENTS.md` says must not be fixed
 *     inside the fork cannot be delegated here by construction.
 *
 *   node local/ci-health-report.mjs               run the checks, open/update/close the issue
 *   node local/ci-health-report.mjs --dry-run     print the verdict and the action it would take
 *   node local/ci-health-report.mjs --fix         let the enablement check clear inherited drift
 *
 * Why the sweep runs here at all: an upstream sync that adds a workflow file enables it, and GitHub has
 * no tree-level way to say "off" (`LOCAL-PATCHES.md` § local(ci)). `local/sync/publish-sync.mjs` sweeps
 * after its own push, so this covers every route that skips it — a gatekeeper merge, a hand push, a
 * sync that did not use that script. Without it, one inherited file costs a delegation: an agent, a
 * PR, and a diff that cannot exist because the fix is repository state, not a file.
 *
 * `--fix` is refused off `refs/heads/main`: a `workflow_dispatch` runs the tree of the ref it was
 * dispatched on, and a branch cut before a lane joined `REQUIRED` reads that lane as drift.
 *
 * Exit codes: 0 all clean, 1 attention needed (the run is red so the failure notifies), 2 could not
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
  {
    name: 'check-actions-enablement',
    script: 'local/check-actions-enablement.mjs',
    // Only this one has a fix: the other two read state rather than own it.
    fixArgs: ['--fix']
  },
  { name: 'check-nightly-liveness', script: 'local/check-nightly-liveness.mjs' },
  { name: 'check-queued-runs', script: 'local/check-queued-runs.mjs' }
]

/** One title, so every run finds the same issue instead of filing a new one each day. */
export const ISSUE_TITLE = 'Fork CI health: attention'
/** A findable marker, so a body edited by hand still reads as machine-owned. */
export const MARKER = '<!-- fork-ci-health -->'
/** The pipeline label. Applying it delegates the issue's product calls and lets the gate merge. */
export const AGENT_AUTO_LABEL = 'agent:auto'

/**
 * Whether this red is a scoped defect the pipeline may take on.
 *
 * Only exit 1 delegates. Exit 2 means a check never reached a verdict — a missing `gh`, an unreadable
 * run history — which is a broken harness rather than a bounded request, and an implementer with
 * auto-merge pointed at it would be guessing at what to fix.
 */
export function judgeDelegation(checks) {
  // Exit 3 first, and it wins over a delegable red: the finding is a fork-owned lane someone enabled on
  // purpose. Neither available action is one an agent may take — disabling it undoes a person's decision,
  // and widening `REQUIRED` hides the finding the issue forbids hiding — so this is a decision, not a
  // scoped defect. It withholds the label from the whole issue rather than from that check: an agent
  // handed a red it may not resolve will resolve it anyway.
  const undecided = checks.filter((check) => check.code === 3)
  if (undecided.length > 0) {
    return {
      delegate: false,
      reason:
        `${undecided.map((check) => check.name).join(', ')} needs a decision only a person can make` +
        ' — a fork-owned lane is enabled that nobody listed, and a sync cannot have done that'
    }
  }
  const red = checks.filter((check) => check.code === 1)
  if (red.length > 0) {
    return {
      delegate: true,
      reason: `${red.map((check) => check.name).join(', ')} needs attention`
    }
  }
  const unknown = checks.filter((check) => check.code !== 0)
  if (unknown.length > 0) {
    return {
      delegate: false,
      reason:
        `${unknown.map((check) => check.name).join(', ')} could not tell` +
        ' — a broken check is not a scoped defect'
    }
  }
  return { delegate: false, reason: 'every check is clean' }
}

/**
 * Reconcile the label with the verdict. `close` is never `remove`: the pipeline keeps `agent:auto` on
 * a closed issue as the audit record of what was delegated.
 */
export function labelAction({ delegate, hasLabel }) {
  if (delegate) {
    return hasLabel ? 'none' : 'add'
  }
  return hasLabel ? 'remove' : 'none'
}

/**
 * What to do with the label, including the rule that `close` never strips it: the pipeline keeps
 * `agent:auto` on a closed issue as the audit record of what was delegated.
 */
export function decideLabel({ action, delegated, labels }) {
  if (action === 'close') {
    return 'none'
  }
  return labelAction({ delegate: delegated, hasLabel: labels.includes(AGENT_AUTO_LABEL) })
}

/**
 * The child environment for the label call. `gh` prefers `GH_TOKEN` over `GITHUB_TOKEN`, but both are
 * overridden so the workflow token cannot win by precedence — the actor has to be a collaborator, not
 * `github-actions[bot]`, or the driver refuses the delegation before it checks permission.
 */
export function labelEnv(base, token) {
  const env = { ...base, GH_TOKEN: token }
  delete env.GITHUB_TOKEN
  return env
}

/** `gh --json labels` yields objects; the names are what the decision reads. */
export function issueLabels(issue) {
  return (issue?.labels ?? [])
    .map((label) => (typeof label === 'string' ? label : label?.name))
    .filter(Boolean)
}

const EXIT_MEANING = {
  0: 'clean',
  1: 'attention needed',
  2: 'could not tell',
  3: 'needs a decision'
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
  const delegation = judgeDelegation(checks)
  const lines = [
    MARKER,
    'Opened by `.github/workflows/fork-ci-health.yml`, which runs the fork health checks daily',
    'and updates this one issue. Closed automatically when they are all clean again.',
    '',
    ...(delegation.delegate
      ? [
          `**Delegated:** \`${AGENT_AUTO_LABEL}\` is applied, so the agent pipeline picks this up and`,
          'decides the product-level calls for it.',
          '',
          'To stop it working this issue, add `agent:hold` — the pipeline honours that over everything,',
          'including an open PR. Removing `agent:auto` is not enough: this body is rewritten every day',
          'and the label is reconciled with the verdict, so a red night puts it back.',
          '',
          'Making the checks green by widening an allowlist is not a fix. Adding a red to',
          '`local/nightly-linux-known-red.json`, or editing `REQUIRED` / `EXPECTED_TRIGGERS` in',
          '`local/actions-enablement-contract.mjs`, hides the finding instead of clearing it and is a',
          'blocking review comment.',
          ''
        ]
      : [`**Not delegated:** no \`${AGENT_AUTO_LABEL}\` — ${delegation.reason}.`, '']),
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
      '',
      'An allowlisted class never reaches this issue: a shard job fails only when its red matches no',
      'entry in that file (`local/check-unit-shard-verdict.mjs`), so a red here is an unclassified one',
      'or an infrastructure failure, and the known-red classes stay out of the delegation.',
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
    delegated: delegation.delegate,
    delegationReason: delegation.reason,
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

/**
 * Whether this invocation may sweep, i.e. let a check turn things off.
 *
 * Why the ref and not just the flag: a `workflow_dispatch` runs the tree of the ref it was dispatched
 * on, and a branch cut before a lane joined `REQUIRED` sees that lane as active-but-unlisted — the
 * sweep would then disable a lane the release line needs. Only the release line may sweep. A run with
 * no `GITHUB_REF` at all is a person at a terminal, which is the one case that keeps its own judgment.
 */
export function maySweep({ fix, dryRun, ref }) {
  if (!fix || dryRun) {
    return false
  }
  return ref === undefined || ref === null || ref === '' ? true : ref === 'refs/heads/main'
}

/** The arguments one check is spawned with: its own, plus the fix only the enablement check declares. */
export function argsFor(check, fix) {
  return fix ? [...(check.fixArgs ?? [])] : []
}

/** The workflow files a sweep disabled, read back out of the enablement check's own report. */
export function disabledBySweep(checks) {
  const enablement = checks.find((check) => check.name === 'check-actions-enablement')
  return String(enablement?.output ?? '')
    .split('\n')
    .map((line) => /^\s*disabled\s+(\.github\/workflows\/\S+)\s+\((.*)\)\s*$/.exec(line))
    .filter(Boolean)
    .map((match) => ({ path: match[1], why: match[2] }))
}

/**
 * What to say when closing the issue.
 *
 * A self-healed night reports clean, so this is where the record lands **when an issue was open**. When
 * none was — the ordinary case, because the sweep usually runs before the red ever reaches an issue —
 * the record is the run log plus the workflows' own `disabled_manually` state, which
 * `gh api repos/<repo>/actions/workflows` answers at any time.
 *
 * Why the reason travels with the path: only one of the three disable routes is "not on the live list".
 * The other two are an `ALLOWED_INERT` lane whose triggers changed shape and one with no pinned
 * triggers, and for those the remedy is the pin plus a re-enable — telling the reader to add the file to
 * `REQUIRED` would leave it `MISSING` instead.
 */
export function closeComment(checks) {
  const closed = 'All fork health checks are clean again.'
  const disabled = disabledBySweep(checks)
  if (disabled.length === 0) {
    return closed
  }
  return [
    closed,
    '',
    'The enablement sweep disabled these on the way. A sync enables every workflow file it adds, and',
    "nothing that is not on the fork's live list may stay on — so if one belongs on, re-enable it and",
    'correct `local/actions-enablement-contract.mjs` in the same change (its `REQUIRED` / `ALLOWED_INERT`',
    'entry, or the triggers pinned for it):',
    '',
    ...disabled.map((entry) => `- \`${entry.path}\` — ${entry.why}`)
  ].join('\n')
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

/**
 * The issue number `gh issue create` reports, taken from the URL it prints.
 *
 * Why not look the issue up by title afterwards: `gh issue list --search` reads GitHub's search index,
 * which lags a freshly created issue by minutes. The first branch dispatch of this workflow created the
 * issue, then failed with "the issue was created but cannot be found by its exact title" — the create
 * had worked and the search had not caught up. The create output is the only immediate, exact answer.
 */
export function issueNumberFromCreateOutput(output) {
  const match = /\/issues\/(\d+)\s*$/.exec(String(output ?? '').trim())
  return match ? Number(match[1]) : null
}

/**
 * Apply or remove the delegation label as a collaborator, not as the workflow.
 *
 * `driver.py::_labeler_permission` reads the `labeled` event's actor and refuses a bot even with write
 * permission, so this has to run on a token whose actor is a person. Failing closed is deliberate: a
 * silent no-label is a red night nobody ever picks up, which is the exact shape this whole file exists
 * to end.
 */
function applyDelegationLabel({ number, add }) {
  const token = (process.env.GH_DELEGATE_TOKEN ?? '').trim()
  if (!token) {
    console.error(
      `ci-health: #${number} needs \`${AGENT_AUTO_LABEL}\` ${add ? 'added' : 'removed'} but ` +
        'GH_DELEGATE_TOKEN is unset, so the pipeline will not see it. Set the AGENT_DELEGATE_TOKEN ' +
        'secret to a token whose actor is a repo collaborator.'
    )
    return 2
  }
  // `gh` prefers GH_TOKEN over GITHUB_TOKEN, but both are overridden so the ambient workflow token
  // cannot win by precedence.
  const env = labelEnv(process.env, token)
  try {
    gh(
      [
        'issue',
        'edit',
        String(number),
        '--repo',
        REPO,
        add ? '--add-label' : '--remove-label',
        AGENT_AUTO_LABEL
      ],
      { env }
    )
  } catch (error) {
    console.error(
      `ci-health: could not ${add ? 'add' : 'remove'} \`${AGENT_AUTO_LABEL}\` on #${number}: ${String(error.message).split('\n')[0]}`
    )
    return 2
  }
  console.log(`ci-health: ${add ? 'applied' : 'removed'} ${AGENT_AUTO_LABEL} on #${number}`)
  return 0
}

function runChecks({ fix = false } = {}) {
  return CHECKS.map((check) => {
    // The delegate token belongs to the label step alone. These checks quote their output into a public
    // issue, so a secret in their environment is one `console.error(process.env)` away from a leak.
    const env = { ...process.env }
    delete env.GH_DELEGATE_TOKEN
    const result = spawnSync('node', [resolve(ROOT, check.script), ...argsFor(check, fix)], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      env
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
    'number,title,labels',
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
  const fixRequested = process.argv.includes('--fix')
  const fix = maySweep({ fix: fixRequested, dryRun, ref: process.env.GITHUB_REF })
  if (fixRequested && !fix) {
    // Said out loud: a dispatch from a branch otherwise reads as an ordinary report-only run, and the
    // reader would think the sweep ran and found nothing.
    const why = dryRun ? '--dry-run' : `ref ${process.env.GITHUB_REF} is not refs/heads/main`
    console.error(`ci-health: not sweeping — ${why}`)
  }
  const runUrl =
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${REPO}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null

  const checks = runChecks({ fix })
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
  const wanted = decideLabel({
    action,
    delegated: verdict.delegated,
    labels: issueLabels(issue)
  })

  console.error(
    `ci-health: ${verdict.ok ? 'all checks clean' : 'attention needed'} — ${action}; label ${wanted}`
  )

  if (dryRun) {
    console.log(verdict.body)
    process.exit(verdict.code)
  }

  let target = issue?.number ?? null
  try {
    if (action === 'create') {
      const created = gh(
        ['issue', 'create', '--repo', REPO, '--title', ISSUE_TITLE, '--body-file', '-'],
        { input: verdict.body }
      )
      // From the create output, because the search index lags a new issue. The lookup is a fallback for
      // a `gh` that stops printing the URL, not the primary path.
      target = issueNumberFromCreateOutput(created) ?? openIssue()?.number ?? null
      if (target === null) {
        throw new Error('the issue was created but its number could not be read from the output')
      }
      console.log(`ci-health: opened #${target}`)
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
        closeComment(checks)
      ])
      console.log(`ci-health: closed #${issue.number}`)
    }
  } catch (error) {
    console.error(`ci-health: ${action} failed: ${String(error.message).split('\n')[0]}`)
    process.exit(2)
  }

  if (wanted !== 'none' && target !== null) {
    const labelCode = applyDelegationLabel({ number: target, add: wanted === 'add' })
    if (labelCode !== 0) {
      process.exit(labelCode)
    }
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
