import type { PRCheckJob, PRCheckStep } from './github/check-types'

/** Step states that mean the step did not pass, shared so surfaces agree on what a failure is. */
export function isFailedStepState(state: string | null | undefined): boolean {
  return state === 'failure' || state === 'failed' || state === 'cancelled' || state === 'timed_out'
}

type SteppedJob = Pick<PRCheckJob, 'steps'> & Partial<Pick<PRCheckJob, 'stepRendering'>>

/** Whether the job's steps are a stage list rather than a GitHub-style drill-down. */
export function rendersEveryStep(job: Partial<Pick<PRCheckJob, 'stepRendering'>>): boolean {
  return job.stepRendering === 'all'
}

/**
 * The steps a details surface should list for a job.
 *
 * Providers differ: GitHub Actions emits a long step list where a passing step is noise, while a
 * CI stage list is short and the stage still running is the answer to "where is this stuck?".
 */
export function visibleCheckSteps(job: SteppedJob): PRCheckStep[] {
  return rendersEveryStep(job)
    ? job.steps
    : job.steps.filter((step) => isFailedStepState(step.conclusion ?? step.status))
}

/** How many steps the compact pane lists before it elides the rest. */
export const CHECK_PANE_VISIBLE_STEP_LIMIT = 8

/** A step that has not settled: queued, running, or waiting on a human. */
export function isRunningStepState(step: Pick<PRCheckStep, 'status' | 'conclusion'>): boolean {
  const state = step.conclusion ?? step.status
  return (
    state === null ||
    state === 'pending' ||
    state === 'action_required' ||
    state === 'queued' ||
    state === 'in_progress' ||
    state === 'requested' ||
    state === 'waiting'
  )
}

export type PaneCheckSteps = {
  steps: PRCheckStep[]
  /** Steps held back by the limit, so the pane can say how many it is not showing. */
  hiddenCount: number
}

/**
 * The pane's compact step list.
 *
 * A stage list can run to hundreds of entries, so the pane keeps only what is still moving and
 * what broke, capped — the full shape belongs on the details page. Running stages come first so a
 * long run of earlier failures can never push the stage happening now out of view.
 */
export function paneCheckSteps(
  job: SteppedJob,
  limit = CHECK_PANE_VISIBLE_STEP_LIMIT
): PaneCheckSteps {
  if (!rendersEveryStep(job)) {
    return { steps: visibleCheckSteps(job), hiddenCount: 0 }
  }
  const running = job.steps.filter((step) => isRunningStepState(step))
  const failed = job.steps.filter((step) => isFailedStepState(step.conclusion ?? step.status))
  const steps = limit >= 0 ? [...running, ...failed].slice(0, limit) : [...running, ...failed]
  return { steps, hiddenCount: running.length + failed.length - steps.length }
}
