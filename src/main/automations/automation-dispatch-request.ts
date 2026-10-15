import type { WebContents } from 'electron'
import { isDeepStrictEqual } from 'node:util'
import type { Automation, AutomationRun } from '../../shared/automations-types'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import type { Store } from '../persistence'
import type { AutomationRunWriter } from './automation-run-writer'
import type { HeadlessAutomationDispatcher } from './headless-dispatch'
import type { HeadlessAutomationDispatchContext } from './headless-dispatch-runner'
import { runHeadlessAutomationDispatch } from './headless-dispatch-runner'
import type { AutomationRunTargetResult } from './run-target-resolution'
import { createAutomationDispatchToken } from './dispatch-tokens'
import { NO_DISPATCH_HOST, sendRendererDispatch } from './dispatch-refusal'
import { automationStepsHaveAgent } from '../../shared/automation-steps'
import {
  automationStepResultsOutputSnapshot,
  runAutomationStepPlan
} from './automation-step-plan-runner'
import type { AutomationShellCommandTarget } from './automation-shell-command-runner'

export type AutomationRendererChannel = Pick<WebContents, 'isDestroyed' | 'send'>

export class AutomationDispatchCancelledError extends Error {}

type DispatchContext = Pick<
  HeadlessAutomationDispatchContext,
  'runPrecheck' | 'markDispatchResult' | 'watchRun'
> & {
  store: Store
  runs: AutomationRunWriter
  isActive(): boolean
  getRenderer(): AutomationRendererChannel | null
  headlessDispatcher: HeadlessAutomationDispatcher | null
  resolveTarget(automation: Automation): AutomationRunTargetResult
}

function definition(automation: Automation) {
  const { lastRunAt: _last, updatedAt: _updated, nextRunAt: _next, ...configured } = automation
  return configured
}

/** Where a plan's script steps run: the workspace, on the host that owns the automation. */
function scriptTarget(
  automation: Automation,
  target: Extract<AutomationRunTargetResult, { ok: true }>
): AutomationShellCommandTarget {
  return automation.executionTargetType === 'ssh'
    ? { type: 'ssh', cwd: target.cwd, connectionId: automation.executionTargetId }
    : { type: 'local', cwd: target.cwd }
}

function destination(target: Extract<AutomationRunTargetResult, { ok: true }>) {
  return {
    cwd: target.cwd,
    repoId: target.repo.id,
    repoPath: target.repo.path,
    host: getRepoExecutionHostId(target.repo),
    setupId: target.setup?.id
  }
}

/** Claim durably, then recheck everything that an acknowledgement wait can invalidate. */
export async function requestAutomationDispatch(
  ctx: DispatchContext,
  automation: Automation,
  run: AutomationRun,
  expectedTarget: AutomationRunTargetResult
): Promise<AutomationRun> {
  const expectedDefinition = structuredClone(definition(automation))
  const expectedDestination = expectedTarget.ok ? destination(expectedTarget) : undefined
  const readRun = (): AutomationRun => {
    if (!ctx.isActive()) {
      throw new AutomationDispatchCancelledError(
        'Orca stopped before this automation could launch.'
      )
    }
    const current = ctx.store.listAutomationRuns(automation.id).find((entry) => entry.id === run.id)
    if (!current || !ctx.store.listAutomations().some((entry) => entry.id === automation.id)) {
      throw new AutomationDispatchCancelledError(
        'The automation was removed before it could launch.'
      )
    }
    return current
  }
  const resolveCurrentTarget = (): AutomationRunTargetResult => {
    const current = ctx.store.listAutomations().find((entry) => entry.id === automation.id)
    if (!current || !isDeepStrictEqual(expectedDefinition, definition(current))) {
      return { ok: false, error: 'The automation changed before this run could launch.' }
    }
    const target = ctx.resolveTarget(current)
    if (
      target.ok &&
      expectedDestination &&
      !isDeepStrictEqual(expectedDestination, destination(target))
    ) {
      return {
        ok: false,
        error: 'The automation destination changed before this run could launch.'
      }
    }
    return target
  }
  const refuse = (error: string) =>
    ctx.runs.updateRun({
      runId: run.id,
      status: 'skipped_unavailable',
      workspaceId: automation.workspaceId,
      error
    })
  const returnDurable = async (current: AutomationRun) => {
    await ctx.store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
    return current
  }

  run = readRun()
  if (run.status !== 'pending') {
    return returnDurable(run)
  }
  let target = resolveCurrentTarget()
  if (!target.ok) {
    return refuse(target.error)
  }
  // Only a plan that ends in an agent step needs somewhere to launch it. A plan of
  // script steps runs in this process, so it must not be refused for having no
  // window open — that is exactly when a scheduled build is most useful.
  const launchesAgent = automationStepsHaveAgent(automation)
  if (launchesAgent && !ctx.getRenderer() && !ctx.headlessDispatcher) {
    return refuse(NO_DISPATCH_HOST)
  }
  await ctx.runs.updateRun({
    runId: run.id,
    status: 'dispatching',
    workspaceId: automation.workspaceId,
    error: null
  })

  run = readRun()
  if (run.status !== 'dispatching') {
    return returnDurable(run)
  }
  target = resolveCurrentTarget()
  if (!target.ok) {
    return refuse(target.error)
  }
  const plan = await runAutomationStepPlan({
    automation,
    target: scriptTarget(automation, target),
    // Written as each step finishes: a build that takes minutes has to be visible
    // while it runs, and a run cut off mid-plan still shows where it stopped.
    onStepResults: async (stepResults) => {
      await ctx.runs.updateRun({
        runId: run.id,
        status: 'dispatching',
        workspaceId: automation.workspaceId,
        stepResults,
        error: null
      })
    }
  })
  if (plan.kind === 'refused') {
    return ctx.runs.updateRun({
      runId: run.id,
      status: 'skipped_unavailable',
      workspaceId: automation.workspaceId,
      stepResults: plan.stepResults,
      error: plan.error
    })
  }
  if (plan.kind === 'failed') {
    return ctx.runs.updateRun({
      runId: run.id,
      status: 'dispatch_failed',
      workspaceId: automation.workspaceId,
      stepResults: plan.stepResults,
      outputSnapshot: automationStepResultsOutputSnapshot(plan.stepResults),
      error: plan.error
    })
  }
  if (plan.kind === 'completed') {
    // The whole run was the scripts: nothing to launch, nothing to watch, and the
    // run is final the moment the last command exits.
    return ctx.runs.updateRun({
      runId: run.id,
      status: 'completed',
      workspaceId: automation.workspaceId,
      stepResults: plan.stepResults,
      outputSnapshot: automationStepResultsOutputSnapshot(plan.stepResults),
      error: null
    })
  }
  run = readRun()
  if (run.status !== 'dispatching') {
    return returnDurable(run)
  }
  target = resolveCurrentTarget()
  if (!target.ok) {
    return refuse(target.error)
  }
  const renderer = ctx.getRenderer()
  if (renderer) {
    return sendRendererDispatch(
      renderer,
      {
        automation,
        run,
        dispatchToken: createAutomationDispatchToken(automation.id, run.id)
      },
      ctx.runs,
      run
    )
  }
  const dispatcher = ctx.headlessDispatcher
  if (!dispatcher) {
    return refuse(NO_DISPATCH_HOST)
  }
  return runHeadlessAutomationDispatch({
    ...ctx,
    automation,
    run,
    target,
    dispatcher: (request) => {
      if (readRun().status !== 'dispatching') {
        throw new AutomationDispatchCancelledError('The run changed before its agent could launch.')
      }
      const latestTarget = resolveCurrentTarget()
      if (!latestTarget.ok) {
        throw new AutomationDispatchCancelledError(latestTarget.error)
      }
      return dispatcher({ ...request, target: latestTarget })
    }
  })
}
