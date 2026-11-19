// The acting half of the enablement check: what `--fix` may change on the repository, and what is
// still outstanding afterwards.
//
// Why its own module: `local/check-actions-enablement.mjs` is the judging half and had reached 570 of
// the 600 counted-line budget when the sweep grew a second direction. This is also the half that calls
// `gh` and mutates repository state, so it is worth reading on its own — same split, same reason as
// `local/actions-enablement-contract.mjs`. Nothing here imports the judging module: the verdict is
// handed in, and the runner is injected, which is what keeps the split one-way.

/** The repository the sweep acts on. Defined here so the two modules share one spelling of it. */
export const REPO = 'nplez1/orca'

/**
 * Run states that would still execute, i.e. that the sweep has to cancel rather than wait out.
 * Disabling a workflow does not stop a run already going, so this is the second half of a disable.
 */
export const CANCELLABLE_STATUSES = new Set([
  'queued',
  'requested',
  'waiting',
  'pending',
  'in_progress'
])

/** The runs `--fix` must cancel: disabling a workflow does not touch a run already going. */
export function cancellableRuns(runs) {
  return (runs ?? [])
    .filter((run) => CANCELLABLE_STATUSES.has(run.status))
    .map((run) => run.databaseId)
}

/** The first line of an error, which is the only part of a `gh` failure worth printing. */
export function firstLine(error) {
  return String(error?.message ?? error)
    .split('\n')[0]
    .trim()
}

/**
 * The problems left after a run: under `--fix`, a target that was disabled (and had its runs
 * cancelled) is resolved. One that failed to disable is not — and neither is one that was disabled
 * but still has a run this command could not cancel.
 *
 * Why a lane the sweep *re-enabled* stays counted in `missing`: the enable is reported on the day it
 * happens (exit 3, see `exitCodeFor`), so the reader sees that a lane was turned back on instead of the
 * state quietly returning to its default. The next run reads it `active` and the finding is gone.
 */
export function residualProblems({ verdict, fix = false, disabled = [], failed = [] }) {
  const handled = new Set(fix ? disabled : [])
  for (const path of failed) {
    handled.delete(path)
  }
  const outstanding = verdict.disableTargets.filter((target) => !handled.has(target.path)).length
  return (
    outstanding +
    verdict.needsDecision.length +
    verdict.missing.length +
    verdict.stale.length +
    verdict.unreadable.length +
    verdict.unapprovedRunners.length +
    verdict.forbiddenTriggers.length +
    verdict.inheritedSchedules.length
  )
}

/**
 * Apply the sweep, and return the paths it handled plus the ones it could not.
 *
 * Two directions, in this order:
 *
 * - `enableTargets` — a `REQUIRED` lane that is present but off. `REQUIRED` already means "disabled is
 *   drift", and a lane that is off cannot be restored by a diff, so the delegation that reported it can
 *   never close it. Restoring it here is the same self-healing the disable direction has had since
 *   2026-11-10.
 * - `disableTargets` — inherited drift, as before.
 *
 * `runGh` is injected so the failure modes a real `gh` hides — an enable refused, a disable that
 * succeeded but whose run lookup failed, a cancel that failed — are covered by tests without a network.
 */
export function applyFixes(verdict, fix, runGh, log = console.log) {
  const enabled = []
  const disabled = []
  const failed = []
  if (!fix) {
    return { enabled, disabled, failed }
  }
  for (const target of verdict.enableTargets ?? []) {
    if (target.id === null) {
      failed.push(target.path)
      console.error(`  FAILED   no workflow id to enable for ${target.path}`)
      continue
    }
    try {
      runGh(['workflow', 'enable', String(target.id), '--repo', REPO])
      enabled.push(target.path)
      log(`  enabled ${target.path} (required, was ${target.state})`)
    } catch (error) {
      failed.push(target.path)
      console.error(`  FAILED   could not re-enable ${target.path}: ${firstLine(error)}`)
    }
  }
  for (const target of verdict.disableTargets) {
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
  return { enabled, disabled, failed }
}
