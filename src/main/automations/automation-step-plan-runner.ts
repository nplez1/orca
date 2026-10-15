/**
 * A plan's script steps, run in order, before anything is dispatched.
 *
 * This is what makes a deterministic automation cost nothing: when the plan has no
 * agent step the run is over when the last command exits, with no PTY, no agent
 * CLI and no completion watcher guessing at an idle prompt. When the plan does end
 * in an agent step, the scripts are the run's own work and the agent is handed the
 * workspace they left behind.
 *
 * The runner is deliberately unaware of persistence and dispatch: it runs commands
 * and reports what happened, so the dispatch protocol keeps owning the fencing and
 * the run writes, and this stays testable with an injected executor.
 */

import {
  automationScriptSteps,
  automationStepsHaveAgent,
  isAutomationAgentStep,
  MAX_AUTOMATION_STEP_STORED_OUTPUT_CHARS,
  resolveAutomationSteps,
  type AutomationStepResult
} from '../../shared/automation-steps'
import type { Automation, AutomationRunOutputSnapshot } from '../../shared/automations-types'
import {
  describeAutomationCommandFailure,
  runAutomationShellCommand,
  type AutomationShellCommandOutcome,
  type AutomationShellCommandTarget
} from './automation-shell-command-runner'

export type AutomationStepPlanOutcome =
  /** Nothing can run: the record's plan is empty or unreadable. */
  | { kind: 'refused'; error: string; stepResults: AutomationStepResult[] }
  /** A step that was told to stop on failure failed, so the run stops here. */
  | { kind: 'failed'; error: string; stepResults: AutomationStepResult[] }
  /** Every step ran and the plan had no agent step, so the run is done. */
  | { kind: 'completed'; stepResults: AutomationStepResult[] }
  /** The scripts ran; the agent step is the dispatcher's to launch. */
  | { kind: 'agent'; stepResults: AutomationStepResult[] }

export type AutomationCommandExecutor = (input: {
  command: string
  timeoutSeconds: number
  target: AutomationShellCommandTarget
}) => Promise<AutomationShellCommandOutcome>

export type RunAutomationStepPlanInput = {
  automation: Automation
  target: AutomationShellCommandTarget
  /** Persists what has run so far, so a long build is visible while it runs. */
  onStepResults?: (stepResults: AutomationStepResult[]) => void | Promise<void>
  /** Seam for tests; the shipped executor runs through the shared process host. */
  execute?: AutomationCommandExecutor
}

function toStepResult(input: {
  index: number
  command: string
  outcome: AutomationShellCommandOutcome
}): AutomationStepResult {
  const { outcome } = input
  return {
    index: input.index,
    kind: 'script',
    label: input.command.trim().split('\n')[0] ?? '',
    status: outcome.timedOut ? 'timed_out' : outcome.exitCode === 0 ? 'succeeded' : 'failed',
    exitCode: outcome.exitCode,
    timedOut: outcome.timedOut,
    durationMs: outcome.durationMs,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    stdoutTruncated: outcome.stdoutTruncated,
    stderrTruncated: outcome.stderrTruncated,
    error: outcome.error,
    startedAt: outcome.startedAt,
    completedAt: outcome.completedAt
  }
}

/**
 * A finished script run's log, in the shape the run view already renders.
 *
 * The agent path records its terminal output here, so a deterministic run writes
 * its own so the panel shows it the same way instead of an empty pane.
 */
export function automationStepResultsOutputSnapshot(
  stepResults: readonly AutomationStepResult[]
): AutomationRunOutputSnapshot | null {
  const content = stepResults
    .map((result) => {
      const header = `$ ${result.label} (exit ${result.exitCode ?? 'none'}${result.timedOut ? ', timed out' : ''})`
      const body = [result.stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean).join('\n')
      return body ? `${header}\n${body}` : header
    })
    .join('\n\n')
    .trim()
  if (!content) {
    return null
  }
  const bounded = content.slice(-MAX_AUTOMATION_STEP_STORED_OUTPUT_CHARS)
  return {
    format: 'plain_text',
    content: bounded,
    capturedAt: Date.now(),
    truncated:
      bounded.length !== content.length ||
      stepResults.some((r) => r.stdoutTruncated || r.stderrTruncated)
  }
}

export function automationStepFailureMessage(input: {
  index: number
  result: AutomationStepResult
  timeoutSeconds: number
}): string {
  const label = input.result.label || `step ${input.index + 1}`
  return `Step ${input.index + 1} (${label}) failed: ${describeAutomationCommandFailure(
    {
      exitCode: input.result.exitCode,
      timedOut: input.result.timedOut,
      durationMs: input.result.durationMs,
      stdout: input.result.stdout,
      stderr: input.result.stderr,
      stdoutTruncated: input.result.stdoutTruncated,
      stderrTruncated: input.result.stderrTruncated,
      error: input.result.error,
      startedAt: input.result.startedAt,
      completedAt: input.result.completedAt
    },
    input.timeoutSeconds
  )}`
}

/** Whether this plan has to be refused before anything runs. */
export function describeAutomationStepPlanRefusal(automation: Automation): string | null {
  const steps = resolveAutomationSteps(automation)
  if (steps.length === 0) {
    return 'This automation has no steps to run.'
  }
  if (automationScriptSteps(automation).length > 0 && automation.workspaceMode === 'new_per_run') {
    // The agent step is what creates a new-per-run workspace, and it runs last, so a
    // script step would have no checkout to run in. Refusing beats running the agent
    // first and pretending the plan was honoured.
    return 'Script steps need an existing workspace, because a workspace created per run is created by the agent step that runs last.'
  }
  return null
}

export async function runAutomationStepPlan(
  input: RunAutomationStepPlanInput
): Promise<AutomationStepPlanOutcome> {
  const refusal = describeAutomationStepPlanRefusal(input.automation)
  if (refusal) {
    return { kind: 'refused', error: refusal, stepResults: [] }
  }
  const execute = input.execute ?? runAutomationShellCommand
  const steps = resolveAutomationSteps(input.automation)
  const stepResults: AutomationStepResult[] = []
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]!
    if (isAutomationAgentStep(step)) {
      continue
    }
    const outcome = await execute({
      command: step.command,
      timeoutSeconds: step.timeoutSeconds,
      target: input.target
    })
    const result = toStepResult({ index, command: step.command, outcome })
    stepResults.push(result)
    // Persisted per step: a long build has to be visible while it runs, and a run
    // cut off mid-plan still shows which step it reached.
    await input.onStepResults?.(stepResults)
    if (result.status !== 'succeeded' && step.onFailure === 'stop') {
      return {
        kind: 'failed',
        stepResults,
        error: automationStepFailureMessage({
          index,
          result,
          timeoutSeconds: step.timeoutSeconds
        })
      }
    }
  }
  return automationStepsHaveAgent(input.automation)
    ? { kind: 'agent', stepResults }
    : { kind: 'completed', stepResults }
}
