import type { Automation } from '../../../shared/automations/automation-definition'
import type { Store } from '../../persistence/loading-store/store'
import type { AutomationRunTargetResult } from '../ownership/run-target-resolution'
import {
  runAutomationScriptSteps,
  type AutomationScriptStepsOutcome,
  type AutomationStepResult
} from '../../../shared/automations/steps/automation-step-results'
import {
  getAutomationScriptSteps,
  resolveAutomationSteps
} from '../../../shared/automations/steps/automation-steps'
import {
  createAutomationScriptStepExecutor,
  type AutomationScriptStepHost
} from './script-step-runner'
import { getLocalProjectWorktreeGitOptions } from '../../workspaces/execution-host/project-runtime-git-options'

/** Null for an automation without script steps; otherwise every step's result, run on this host. */
export async function runAutomationRequestScriptSteps(
  store: Store,
  automationId: string,
  resolveTarget: (automation: Automation) => AutomationRunTargetResult
): Promise<AutomationScriptStepsOutcome | null> {
  const automation = store.listAutomations().find((entry) => entry.id === automationId)
  if (!automation) {
    throw new Error('Automation not found.')
  }
  if (automation.steps === undefined) {
    return null
  }
  const resolved = resolveAutomationSteps(automation)
  if (!resolved.ok) {
    return refusedScriptSteps(resolved.error)
  }
  const steps = getAutomationScriptSteps({ steps: resolved.steps })
  if (steps.length === 0) {
    return null
  }
  return await runAutomationScriptSteps(
    steps,
    createAutomationScriptStepExecutor(scriptStepHost(store, automation, resolveTarget(automation)))
  )
}

function scriptStepHost(
  store: Store,
  automation: Automation,
  target: AutomationRunTargetResult
): AutomationScriptStepHost {
  if (!target.ok) {
    return { type: 'unverifiable', error: target.error }
  }
  if ('bot' in target) {
    return { type: 'unverifiable', error: 'A bot automation cannot run script steps.' }
  }
  if (automation.executionTargetType === 'ssh') {
    // Refused, never skipped: the SSH relay has no hook executor yet.
    return {
      type: 'unverifiable',
      error: 'Script steps do not run on SSH hosts yet.'
    }
  }
  return {
    type: 'local',
    cwd: target.cwd,
    repo: target.repo,
    runtimeTarget: getLocalProjectWorktreeGitOptions(store, target.repo)
  }
}

/** Steps a host cannot even read stop the run with one recorded refusal. */
function refusedScriptSteps(error: string): AutomationScriptStepsOutcome {
  const now = Date.now()
  const result: AutomationStepResult = {
    stepId: 'steps',
    kind: 'script',
    script: '',
    contentHash: null,
    outcome: 'unverifiable',
    exitCode: null,
    output: '',
    outputTruncated: false,
    error,
    startedAt: now,
    completedAt: now,
    durationMs: 0
  }
  return { results: [result], stoppedBy: result, env: {} }
}
