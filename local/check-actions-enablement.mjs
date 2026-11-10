#!/usr/bin/env node
/**
 * Check the fork's GitHub Actions enablement after an upstream merge or sync.
 *
 * Upstream's Actions fleet is disabled at the repository, not in the tree
 * (LOCAL-PATCHES.md -> "local(ci): which workflows are live on this fork"), so a merge that adds
 * or edits a workflow file can re-enable it with no visible diff. An enabled workflow with a
 * pull_request/push/schedule trigger then spends minutes and adds mystery checks to every PR.
 *
 *   node local/check-actions-enablement.mjs          report only; exit 1 on drift
 *   node local/check-actions-enablement.mjs --fix    disable everything that drifted, and stop the
 *                                                   runs it had already started
 *
 * Four things this does beyond comparing names, because a name is not what spends the minutes:
 *
 * - it pins each enabled file's `on:` keys, so a sync that adds `schedule`, `push` or
 *   `pull_request` to a lane is reported rather than inherited (2026-10-31: this used to cover only
 *   the allowed-inert files, which left the eleven required ones unguarded). Only the trigger keys are
 *   pinned, not their filters: a cron edit or a dropped `paths:` filter passes, and the file is the
 *   contract for those;
 * - it rejects `pull_request_target` and `workflow_run` on any active file, because both run with a
 *   write token against code from a fork, and `ci-closed-pr-caches.yml` must stay off;
 * - it rejects a runner family this fork does not provision — `blacksmith-*`, `self-hosted`, another
 *   vendor's prefix, or a larger-runner suffix — in any file an active workflow can reach, including
 *   through `uses: ./.github/workflows/*.yml`. Enablement state does not stop a called workflow from
 *   running, so scanning only the active files would miss exactly where the 2026-10-26 incident was:
 *   `unit-tests.yml`'s `runner` input defaults to `blacksmith-4vcpu-ubuntu-2404`. A job on such a
 *   runner queues until GitHub's 24 h limit, and `timeout-minutes` does not bound it;
 * - it pages through the workflow list so a 101st file is not invisible, and `--fix` cancels the
 *   queued and in-progress runs of whatever it disables, because disabling a workflow does not stop a
 *   run that is already going.
 *
 * Exit codes: 0 clean, 1 drift or an unverifiable entry, 2 cannot reach the API — "cannot tell" is
 * never a pass.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse } from 'yaml'
import {
  ACCEPTED_RUNNER_LABELS,
  ALLOWED_INERT,
  EXPECTED_TRIGGERS,
  FORK_SCHEDULES,
  REQUIRED
} from './actions-enablement-contract.mjs'
import { isForkOwnedPath } from './fork-owned-paths.mjs'

const REPO = 'nplez1/orca'
const ROOT = resolve(import.meta.dirname, '..')

// Re-exported: `LOCAL-PATCHES.md` § local(ci) and both test files name this module's `REQUIRED`, and a
// name that moved is a doc that stopped being true.
export { ACCEPTED_RUNNER_LABELS, ALLOWED_INERT, EXPECTED_TRIGGERS, FORK_SCHEDULES, REQUIRED }

/**
 * Runner families this fork does not provision, as patterns rather than one vendor's prefix. A job
 * asking for any of them waits for a runner that will never claim it, which `timeout-minutes` cannot
 * bound. **This is a deny-list, not an allow-list**: a typo such as `ubunut-latest`, or a vendor
 * nobody has added here yet, still passes. It also cannot tell a label from prose that names one — a
 * `with: body:` note saying "never use self-hosted runners" reads as a request. Allowing only
 * `ubuntu-*`/`windows-*`/`macos-*` without a larger suffix would be stricter, and is the change to make
 * if this ever misses something real. The larger-runner suffixes are here because those bill even on a public repository, so they
 * are a cost decision as well as a queue one; `self-hosted` is here because on a public fork it is the
 * shortest path from a fork PR to someone's machine.
 */
const UNPROVISIONED = [
  // Third-party runner services. Case-insensitive because GitHub treats labels that way.
  /(?<![\w.-])(?:blacksmith|buildjet|depot|namespace|ubicloud|warp|cirrus|arc)-[a-z0-9.-]+/gi,
  /(?<![\w.-])self-hosted\b/gi,
  // Larger GitHub runners: billed even on a public repository. The macOS names end in a size word and
  // the Linux/Windows ones end in a core count, in two spellings.
  /(?<![\w.-])[a-z0-9._-]+-(?:large|xlarge|2xlarge|4xlarge|8xlarge)\b/gi,
  /(?<![\w.-])[a-z0-9._-]+-\d+(?:-cores?|core)\b/gi
]

function unprovisionedIn(value) {
  const found = []
  for (const pattern of UNPROVISIONED) {
    found.push(...(value.match(pattern) ?? []))
  }
  return found
}

/** Triggers that run with a write token against a fork's code. Never acceptable on an active file. */
const FORBIDDEN_TRIGGERS = new Set(['pull_request_target', 'workflow_run'])

/** Run states that would still execute, i.e. that `--fix` has to cancel rather than wait out. */
export const CANCELLABLE_STATUSES = new Set([
  'queued',
  'requested',
  'waiting',
  'pending',
  'in_progress'
])

/**
 * The `on:` keys of a workflow file. Handles the three shapes GitHub accepts — `on: push`,
 * `on: [push, pull_request]`, and `on: { push: … }` — and the YAML-1.1 reading of `on:`
 * as the boolean `true`, which is what a libYAML-backed parser hands back.
 */
export function triggersOf(text) {
  const doc = parse(text)
  if (doc === null || typeof doc !== 'object') {
    return []
  }
  const on = Object.hasOwn(doc, 'on') ? doc.on : doc[true]
  if (on === null || on === undefined) {
    return []
  }
  if (typeof on === 'string') {
    return [on]
  }
  if (Array.isArray(on)) {
    return on.map(String)
  }
  return typeof on === 'object' ? Object.keys(on) : []
}

/**
 * Keys whose strings are a command or prose, never a runner selector. Everything else is scanned,
 * because a label reaches a runner from more places than `runs-on`: a matrix list (`matrix: { runner:
 * [...] }`) and a caller's `with: { runner: … }` both select one, and the 2026-10-28 incident was a
 * `with:`. Excluding `run:` and `if:` is what keeps `unit-tests.yml`'s byte-comparison of an 8-vcpu
 * label from reading as a request for one.
 */
const NO_LABEL_KEYS = new Set([
  'run',
  'script',
  'if',
  'env',
  'name',
  'description',
  'comment',
  'shell',
  'working-directory',
  'uses',
  'id'
])

/** Every `blacksmith-*` label a file could actually ask for. */
export function runnerLabelsOf(text) {
  const labels = new Set()
  // Why the exclusion is inherited rather than decided per key: `env: { NOTE: blacksmith-… }` and
  // `with: { script: … }` put the value under a key of its own, so a nearest-key test would read both
  // as runner requests. Anything under `run`, `script`, `if`, `env`, `name` or prose is prose.
  const visit = (node, key, excluded) => {
    const skip = excluded || NO_LABEL_KEYS.has(key)
    if (typeof node === 'string') {
      if (!skip) {
        for (const match of unprovisionedIn(node)) {
          labels.add(match)
        }
      }
      return
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item, key, skip)
      }
      return
    }
    if (node !== null && typeof node === 'object') {
      for (const [childKey, value] of Object.entries(node)) {
        visit(value, childKey, skip)
      }
    }
  }
  visit(parse(text), '', false)
  return [...labels].sort()
}

/**
 * The local workflows a file reaches with `uses: ./.github/workflows/x.yml`. A called workflow runs
 * whether or not it is enabled, so its runner labels are as live as the caller's.
 */
export function calleesOf(text) {
  const doc = parse(text)
  const jobs = doc !== null && typeof doc === 'object' ? (doc.jobs ?? {}) : {}
  const found = new Set()
  for (const job of Object.values(jobs)) {
    // Parsed rather than matched in the text: a comment or a `run:` string that mentions a workflow
    // path is not a call edge, and a hand-scan of the tree found 37 textual matches where the real
    // edges are fewer.
    const uses = typeof job?.uses === 'string' ? job.uses.trim() : ''
    const match = /^\.\/\.github\/workflows\/([\w.-]+\.ya?ml)$/.exec(uses)
    if (match) {
      found.add(`.github/workflows/${match[1]}`)
    }
  }
  return [...found].sort()
}

/** `gh api --paginate --slurp` yields one object per page; the workflow list is what we want. */
export function workflowsFromPages(pages) {
  return pages.flatMap((page) => page?.workflows ?? [])
}

export function workflowListArgs() {
  return ['api', '--paginate', '--slurp', `repos/${REPO}/actions/workflows?per_page=100`]
}

/** The repo-level switch. Distinct from every per-workflow state: it can be off while they read active. */
export function actionsPermissionsArgs() {
  return ['api', `repos/${REPO}/actions/permissions`]
}

/**
 * Whether GitHub has Actions switched off for the whole repository.
 *
 * Why this exists: on 2026-11-06 GitHub disabled Actions on this repo to stop compute "wasted" by
 * inherited upstream workflows. Every per-workflow state still read `active`, the enablement endpoints
 * still read `enabled: true`, and this check — the one whose whole job is noticing that CI is not
 * running — reported `OK` while nothing had run for 33 hours.
 *
 * What it cannot do: run from inside Actions, which is where this check normally runs. A disabled
 * repository cannot run the workflow that would report it disabled. It is useful when invoked from the
 * host instead (`node local/check-actions-enablement.mjs`), which is the only vantage point that can
 * see an absence of runs as an absence.
 *
 * Only an explicit `false` is reported. A failed read stays silent: `--fix` is destructive and this is
 * not worth a spurious red on a permissions hiccup.
 */
export function judgeActionsEnabled(payload) {
  if (payload === null || typeof payload !== 'object') {
    return null
  }
  if (payload.enabled !== false) {
    return null
  }
  return {
    reason: `Actions is disabled for ${REPO}, so no lane here can run at all`,
    allowedActions: payload.allowed_actions ?? null
  }
}

/** The runs `--fix` must cancel: disabling a workflow does not touch a run already going. */
export function cancellableRuns(runs) {
  return (runs ?? [])
    .filter((run) => CANCELLABLE_STATUSES.has(run.status))
    .map((run) => run.databaseId)
}

const sameTriggers = (left, right) =>
  left.length === right.length &&
  left.every((key) => right.includes(key)) &&
  right.every((key) => left.includes(key))

/**
 * Judge enablement from already-fetched data, so the decision is testable without a network.
 *
 * `facts` maps a workflow path to `{ triggers, runnerLabels }`, or to `{ error }` when the file could
 * not be read — a missing entry is reported too, never treated as "inert, presumably".
 */
export function judgeEnablement(
  { workflows, facts = {} },
  {
    required = REQUIRED,
    allowedInert = ALLOWED_INERT,
    expected = EXPECTED_TRIGGERS,
    forkSchedules = FORK_SCHEDULES,
    acceptedRunners = ACCEPTED_RUNNER_LABELS
  } = {}
) {
  const allowed = new Set([...required, ...allowedInert])
  const byPath = new Map(workflows.map((workflow) => [workflow.path, workflow]))
  const active = workflows.filter((w) => w.state === 'active')
  const drift = active.filter((w) => !allowed.has(w.path))
  const missing = required
    .map((path) => ({ path, workflow: byPath.get(path) }))
    .filter(({ workflow }) => !workflow || workflow.state !== 'active')
    .map(({ path, workflow }) => ({ path, state: workflow ? workflow.state : 'absent' }))
  const stale = Object.keys(expected)
    .filter((path) => !byPath.has(path))
    .map((path) => ({ path, reason: 'no workflow file by that path on the repository' }))

  const triggerDrift = []
  const requiredTriggerDrift = []
  const inheritedSchedules = []
  const unpinned = []
  const unapprovedRunners = []
  const forbiddenTriggers = []
  const unreadable = []
  for (const workflow of active) {
    // A file that is active without being allowed is already a disable target; checking its triggers
    // or labels too would report one problem as three.
    if (!allowed.has(workflow.path)) {
      continue
    }
    const entry = facts[workflow.path]
    if (entry === undefined) {
      unreadable.push({ path: workflow.path, reason: 'not read, so its triggers are unproven' })
      continue
    }
    if (!Array.isArray(entry.triggers)) {
      unreadable.push({ path: workflow.path, reason: entry.error ?? 'unreadable' })
      continue
    }
    const forbidden = entry.triggers.filter((trigger) => FORBIDDEN_TRIGGERS.has(trigger))
    if (forbidden.length > 0) {
      forbiddenTriggers.push({ path: workflow.path, triggers: forbidden })
    }
    const pinned = expected[workflow.path]
    if (pinned === undefined) {
      unpinned.push({ path: workflow.path, all: entry.triggers })
      continue
    }
    // Checked before the pin comparison and independent of it: `EXPECTED_TRIGGERS` can only compare a
    // lane to what it was, and what it was may be an upstream cron this fork never wanted.
    if (entry.triggers.includes('schedule') && !Object.hasOwn(forkSchedules, workflow.path)) {
      inheritedSchedules.push({ path: workflow.path, id: workflow.id })
    }
    if (!sameTriggers(entry.triggers, pinned)) {
      const drift = { path: workflow.path, expected: pinned, all: entry.triggers }
      triggerDrift.push(drift)
      if (required.includes(workflow.path)) {
        requiredTriggerDrift.push(drift)
      }
    }
  }

  // Runner labels are read for the active files *and* everything they reach, transitively: a called
  // workflow runs regardless of its own state, so a label two calls down is as live as the caller's.
  const reachable = new Map()
  const queue = []
  for (const workflow of active) {
    if (allowed.has(workflow.path)) {
      reachable.set(workflow.path, workflow.path)
      queue.push(workflow.path)
    }
  }
  while (queue.length > 0) {
    const from = queue.shift()
    for (const callee of facts[from]?.callees ?? []) {
      if (reachable.has(callee) || callee === from) {
        continue
      }
      reachable.set(callee, reachable.get(from) ?? from)
      queue.push(callee)
    }
  }
  const reportedUnreadable = new Set(unreadable.map((entry) => entry.path))
  for (const [path, reachedFrom] of reachable) {
    const entry = facts[path]
    if (entry?.error !== undefined) {
      // A callee that cannot be read is not "no labels": it is an unproven file that an active lane
      // reaches, which is the same problem an unreadable active file is.
      if (!reportedUnreadable.has(path)) {
        unreadable.push({ path, reason: `reached from ${reachedFrom}: ${entry.error}` })
        reportedUnreadable.add(path)
      }
      continue
    }
    const labels = entry?.runnerLabels ?? []
    const accepted = acceptedRunners[path]?.labels ?? []
    const extra = labels.filter((label) => !accepted.includes(label))
    if (extra.length > 0) {
      unapprovedRunners.push({ path, labels: extra, reachedFrom })
    }
  }

  // A file a sync cannot have added. Enabling one is always a deliberate act here, so its being active
  // without an entry is a decision for a person and never something a sweep may revert.
  const forkOwnedDrift = drift
    .filter((entry) => isForkOwnedPath(entry.path))
    .map((entry) => ({ path: entry.path, id: entry.id }))
  const requiredUnpinned = unpinned.filter((entry) => required.includes(entry.path))

  // Everything `--fix` is allowed to turn off. A required lane is never in here: disabling the
  // watchdog that reports the problem is worse than the problem, and REQUIRED already means "disabled
  // is drift", so turning one off would manufacture the drift it exists to prevent. That covers a
  // dropped pin as well as a changed trigger — otherwise one deleted `EXPECTED_TRIGGERS` row is enough
  // for the sweep to disarm the lane that reports it.
  const disableTargets = [
    ...drift
      .filter((entry) => !isForkOwnedPath(entry.path))
      .map((entry) => ({
        path: entry.path,
        id: entry.id,
        why: "active but not on the fork's live list"
      })),
    ...triggerDrift
      .filter((entry) => !required.includes(entry.path))
      .map((entry) => ({
        path: entry.path,
        id: byPath.get(entry.path)?.id ?? null,
        why: 'its triggers changed shape'
      })),
    ...unpinned
      .filter((entry) => !required.includes(entry.path))
      .map((entry) => ({
        path: entry.path,
        id: byPath.get(entry.path)?.id ?? null,
        why: 'active with no pinned triggers'
      }))
  ]

  const problems =
    disableTargets.length +
    forkOwnedDrift.length +
    requiredUnpinned.length +
    requiredTriggerDrift.length +
    missing.length +
    stale.length +
    unreadable.length +
    unapprovedRunners.length +
    forbiddenTriggers.length +
    inheritedSchedules.length
  return {
    total: workflows.length,
    activeCount: active.length,
    drift,
    missing,
    stale,
    triggerDrift,
    requiredTriggerDrift,
    inheritedSchedules,
    unpinned,
    unapprovedRunners,
    forbiddenTriggers,
    unreadable,
    disableTargets,
    forkOwnedDrift,
    requiredUnpinned,
    ok: problems === 0
  }
}

/**
 * The problems left after a run: under `--fix`, a target that was disabled (and had its runs
 * cancelled) is resolved. One that failed to disable is not — and neither is one that was disabled
 * but still has a run this command could not cancel.
 */
export function residualProblems({ verdict, fix = false, disabled = [], failed = [] }) {
  const handled = new Set(fix ? disabled : [])
  for (const path of failed) {
    handled.delete(path)
  }
  const outstanding = verdict.disableTargets.filter((target) => !handled.has(target.path)).length
  return (
    outstanding +
    verdict.forkOwnedDrift.length +
    verdict.requiredUnpinned.length +
    verdict.missing.length +
    verdict.stale.length +
    verdict.unreadable.length +
    verdict.unapprovedRunners.length +
    verdict.forbiddenTriggers.length +
    verdict.requiredTriggerDrift.length +
    verdict.inheritedSchedules.length
  )
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
}

/**
 * The same runner with gh's stderr discarded, for a probe whose failure is an expected answer.
 *
 * Why: `execFileSync` inherits stderr by default, so the repo-wide Actions-permission read — which
 * needs admin and therefore always fails from a workflow token — used to drop gh's own "Resource not
 * accessible by integration (HTTP 403)" into the job log, and `local/ci-health-report.mjs` quotes
 * that log into the public health issue, where it read as a finding. Only this probe is quiet: for the
 * real ones, gh's stderr is what `firstLine(error)` turns into the message.
 */
function ghQuiet(args) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

/**
 * Read the pinned facts from this checkout, following local `uses:` edges so a called workflow's runner
 * labels are read too. Bounded by the facts map itself, because a call graph can cycle.
 */
export function readFacts(paths, root = ROOT) {
  const facts = {}
  const queue = [...paths]
  while (queue.length > 0) {
    const path = queue.shift()
    if (Object.hasOwn(facts, path)) {
      continue
    }
    const file = join(root, path)
    if (!existsSync(file)) {
      facts[path] = { error: 'not in this checkout' }
      continue
    }
    try {
      const text = readFileSync(file, 'utf8')
      const callees = calleesOf(text)
      facts[path] = { triggers: triggersOf(text), runnerLabels: runnerLabelsOf(text), callees }
      queue.push(...callees.filter((callee) => !Object.hasOwn(facts, callee)))
    } catch (error) {
      facts[path] = { error: firstLine(error) }
    }
  }
  return facts
}

function firstLine(error) {
  return String(error?.message ?? error)
    .split('\n')[0]
    .trim()
}

/**
 * Print the verdict, disabling and cancelling under `--fix`, and return the paths it handled plus
 * the ones it could not.
 *
 * `runGh` is a parameter so the two failure modes a real `gh` hides — disabling succeeded but the run
 * lookup failed, and the cancel itself failing — are covered by tests without a network.
 */
export function applyFixes(verdict, fix, runGh = gh, log = console.log) {
  const disabled = []
  const failed = []
  for (const target of verdict.disableTargets) {
    if (!fix) {
      continue
    }
    if (target.id === null) {
      failed.push(target.path)
      console.error(`  FAILED   no workflow id to disable for ${target.path}`)
      continue
    }
    try {
      runGh(['workflow', 'disable', String(target.id), '--repo', REPO])
      disabled.push(target.path)
      log(`  disabled ${target.path} (${target.why})`)
    } catch (error) {
      failed.push(target.path)
      console.error(`  FAILED   could not disable ${target.path}: ${firstLine(error)}`)
      continue
    }
    // Cancelling is a second step on purpose: disabling does not stop a run already going, and the
    // run ids are read by workflow id (which works for a disabled workflow) rather than by path.
    try {
      const runs = cancellableRuns(
        JSON.parse(
          runGh([
            'run',
            'list',
            '--repo',
            REPO,
            '--workflow',
            String(target.id),
            '--limit',
            '50',
            '--json',
            'databaseId,status'
          ])
        )
      )
      for (const runId of runs) {
        runGh(['run', 'cancel', String(runId), '--repo', REPO])
      }
      if (runs.length > 0) {
        log(`  cancelled ${runs.length} run(s) of ${target.path} that were still going`)
      }
    } catch (error) {
      failed.push(target.path)
      const reason = firstLine(error)
      console.error(
        `  FAILED   ${target.path} is disabled, but its running jobs could not be cancelled: ${reason}`
      )
    }
  }
  return { disabled, failed }
}

function report(verdict, fix) {
  console.log(
    `check-actions: ${verdict.total} workflows on ${REPO}, ${verdict.activeCount} active ` +
      `(${REQUIRED.length} required + ${ALLOWED_INERT.length} allowed-inert)`
  )
  for (const w of verdict.drift) {
    console.log(`  DRIFT    active but not on the fork's live list: ${w.path} — ${w.name}`)
  }
  for (const f of verdict.forkOwnedDrift) {
    console.log(`  DECIDE   active with no entry, and a sync cannot have added it: ${f.path}`)
  }
  for (const u of verdict.requiredUnpinned) {
    console.log(`  UNPINNED required but no triggers pinned, so its shape is unproven: ${u.path}`)
  }
  for (const m of verdict.missing) {
    console.log(`  MISSING  required but ${m.state}: ${m.path}`)
  }
  for (const s of verdict.stale) {
    console.log(`  STALE    pinned entry with ${s.reason}: ${s.path}`)
  }
  for (const t of verdict.triggerDrift) {
    const only = verdict.requiredTriggerDrift.includes(t)
      ? ' (required: reported, not disabled)'
      : ''
    console.log(
      `  TRIGGER  pinned [${t.expected.join(', ')}] but the file fires on [${t.all.join(', ')}]${only}: ${t.path}`
    )
  }
  for (const s of verdict.inheritedSchedules) {
    console.log(
      `  SCHEDULE an inherited cron this fork never asked for — delete the schedule from the file: ${s.path}`
    )
  }
  if (verdict.actionsDisabled) {
    console.log(`  DISABLED ${verdict.actionsDisabled.reason}`)
  }
  for (const u of verdict.unpinned) {
    if (!verdict.requiredUnpinned.some((entry) => entry.path === u.path)) {
      console.log(`  UNPINNED active but no triggers pinned, so its shape is unproven: ${u.path}`)
    }
  }
  for (const u of verdict.unapprovedRunners) {
    const via = u.reachedFrom === u.path ? '' : ` via ${u.reachedFrom}`
    console.log(
      `  RUNNER   names a runner this fork does not provision${via}: ${u.path} (${u.labels.join(', ')})`
    )
  }
  for (const p of verdict.forbiddenTriggers) {
    console.log(
      `  WRITE    active with ${p.triggers.join(', ')}, which runs with a write token: ${p.path}`
    )
  }
  for (const u of verdict.unreadable) {
    console.log(`  UNKNOWN  cannot read the workflow: ${u.path}: ${u.reason}`)
  }

  const { disabled, failed } = applyFixes(verdict, fix)
  const residual = residualProblems({ verdict, fix, disabled, failed })
  if (verdict.actionsDisabled) {
    return residual + 1
  }
  if (residual > 0) {
    if (verdict.disableTargets.length > 0 && !fix) {
      console.log('  fix: node local/check-actions-enablement.mjs --fix')
    }
    if (
      verdict.triggerDrift.length > 0 ||
      verdict.unpinned.length > 0 ||
      verdict.stale.length > 0
    ) {
      console.log(
        '  a workflow changed the triggers it fires on, or no longer exists: if that is intended, ' +
          'update EXPECTED_TRIGGERS and record it in LOCAL-PATCHES.md § local(ci)'
      )
    }
    // Suppressed for a file the sweep is already disabling: the useful decision is about what the
    // caller may reach, not about a file that is about to be off either way.
    const handled = new Set(verdict.disableTargets.map((target) => target.path))
    const viaCallee = verdict.unapprovedRunners.filter(
      (entry) => !handled.has(entry.path) && entry.reachedFrom !== entry.path
    )
    const unhandledOwn = [
      ...verdict.unapprovedRunners.filter(
        (entry) => !handled.has(entry.path) && entry.reachedFrom === entry.path
      ),
      ...verdict.forbiddenTriggers.filter((entry) => !handled.has(entry.path))
    ]
    for (const entry of viaCallee) {
      console.log(
        `  decide   whether ${entry.reachedFrom} may call a workflow that asks for ${entry.labels.join(', ')}: ` +
          'a callee runs whatever its own enablement state is, so the caller is the decision'
      )
    }
    if (unhandledOwn.length > 0) {
      console.log(
        '  this one is not auto-fixed: decide whether the file may be active at all, and record the ' +
          'decision in LOCAL-PATCHES.md § local(ci)'
      )
    }
    if (verdict.forkOwnedDrift.length > 0) {
      console.log(
        '  decide   a fork-owned lane is enabled with no entry: add it to REQUIRED or ALLOWED_INERT ' +
          'with its triggers pinned, in the commit that enabled it, or disable it. The sweep will not ' +
          'do it for you — a sync cannot have turned this one on, so it was a person.'
      )
    }
    for (const path of failed) {
      // A workflow can be off and still be a problem: disabling does not stop a run already going.
      console.log(
        disabled.includes(path)
          ? `  STILL    ${path} is disabled, but a run of it may still be going`
          : `  STILL    ${path} could not be disabled`
      )
    }
  }
  return residual
}

function main() {
  const fix = process.argv.includes('--fix')
  let workflows
  try {
    workflows = workflowsFromPages(JSON.parse(gh(workflowListArgs())))
  } catch (error) {
    console.error(`check-actions: gh api failed: ${firstLine(error)}`)
    process.exit(2)
  }

  // Read defensively: the workflow list above already proved `gh` works, so a failure here is about
  // this endpoint rather than about the machine, and it must not turn a real verdict into an error.
  let actionsEnabled = null
  try {
    actionsEnabled = judgeActionsEnabled(JSON.parse(ghQuiet(actionsPermissionsArgs())))
  } catch {
    actionsEnabled = null
  }

  const verdict = judgeEnablement({
    workflows,
    facts: readFacts(Object.keys(EXPECTED_TRIGGERS), ROOT)
  })
  verdict.actionsDisabled = actionsEnabled
  if (report(verdict, fix) > 0) {
    process.exit(1)
  }
  console.log('  OK')
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  // Why: an uncaught throw exits 1, which is the same code as "attention needed". The exit codes are a
  // contract `ci-health-report` reads — it delegates 1 to the autonomous pipeline and withholds 2 — so a
  // crash that exits 1 would hand a broken harness to an implementer with auto-merge.
  try {
    main()
  } catch (error) {
    console.error(`check-actions: could not tell — ${firstLine(error)}`)
    process.exit(2)
  }
}
