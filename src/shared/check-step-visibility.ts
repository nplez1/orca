import type { PRCheckJob, PRCheckStep } from './github/check-types'

/** Step states that mean the step did not pass, shared so surfaces agree on what a failure is. */
export function isFailedStepState(state: string | null | undefined): boolean {
  return state === 'failure' || state === 'failed' || state === 'cancelled' || state === 'timed_out'
}

type SteppedJob = Pick<PRCheckJob, 'steps'> & Partial<Pick<PRCheckJob, 'stepRendering'>>

/** Whether the job's steps are all worth listing, rather than only the ones that went wrong. */
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
