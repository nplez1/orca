import type { Automation } from '../../../shared/automations/automation-definition'
import {
  AUTOMATION_STEPS_STAND_DOWN_PROMPT,
  AutomationStepsError,
  getAutomationAgentPrompt,
  getAutomationScriptSteps,
  parseAutomationStepsForWrite,
  type AutomationAgentStepMarker,
  type AutomationScriptStep,
  type AutomationStepRecord
} from '../../../shared/automations/steps/automation-steps'

function isAgentMarker(step: AutomationStepRecord): step is AutomationAgentStepMarker {
  return step.kind === 'agent'
}

type StepsRecord = Pick<Automation, 'steps' | 'prompt' | 'surface'> & { bot?: unknown }

function sameInvocation(left: AutomationScriptStep, right: AutomationScriptStep): boolean {
  return (
    left.id === right.id &&
    left.script === right.script &&
    JSON.stringify(left.args ?? []) === JSON.stringify(right.args ?? [])
  )
}

/** A write never carries a pin; one survives only on a step whose path and arguments are unchanged. */
function carryApprovals(
  steps: AutomationStepRecord[],
  current: Pick<Automation, 'steps'> | undefined
): AutomationStepRecord[] {
  const approved = getAutomationScriptSteps(current ?? {}).filter((step) => step.approvedPin)
  return steps.map((step) => {
    if (step.kind !== 'script') {
      return step
    }
    const previous = approved.find((entry) => sameInvocation(entry, step))
    return previous?.approvedPin ? { ...step, approvedPin: previous.approvedPin } : step
  })
}

/**
 * Settles `steps` on a record being written. A write that names steps replaces them (null
 * clears); any other write keeps the stored ones. With steps, the user's prompt moves to the agent
 * step and the record's `prompt` holds the stand-down text, so an older host that ignores steps
 * never runs the agent without its gate.
 */
export function applyAutomationStepsWrite(
  automation: StepsRecord,
  write: { steps?: unknown; prompt?: string },
  current?: Pick<Automation, 'steps' | 'prompt'>
): void {
  const written = Object.hasOwn(write, 'steps')
    ? parseAutomationStepsForWrite(write.steps)
    : current?.steps
  const userPrompt = (value: string | undefined) =>
    value && value !== AUTOMATION_STEPS_STAND_DOWN_PROMPT ? value : undefined
  // The written prompt, else the written agent step's (a move copies the record), else the stored one.
  const prompt =
    userPrompt(write.prompt) ??
    userPrompt(written?.find(isAgentMarker)?.prompt) ??
    userPrompt(current ? getAutomationAgentPrompt(current) : automation.prompt) ??
    ''
  delete automation.steps
  if (!written) {
    // Only a write that removes steps moves the prompt back; an agent-only write keeps its own.
    if (current?.steps) {
      automation.prompt = prompt
    }
    return
  }
  if (automation.bot) {
    throw new AutomationStepsError('steps_invalid', 'A bot automation cannot have script steps.')
  }
  const steps = carryApprovals(written, current).map((step) =>
    step.kind === 'agent' ? { kind: 'agent' as const, id: step.id, prompt } : step
  )
  if (automation.surface === 'chat' && steps.some((step) => step.kind === 'agent')) {
    // A chat session takes no environment, so the agent step would lose the scripts' handoff.
    throw new AutomationStepsError(
      'steps_invalid',
      'Script steps hand their results to a terminal agent. Choose a terminal agent, or run the scripts without one.'
    )
  }
  automation.steps = steps
  automation.prompt = AUTOMATION_STEPS_STAND_DOWN_PROMPT
}

/** A record imported from another store arrives unapproved: only this host's user approves a script. */
export function withoutScriptStepApprovals<T extends Pick<Automation, 'steps'>>(automation: T): T {
  if (!automation.steps?.some((step) => step.kind === 'script' && step.approvedPin)) {
    return automation
  }
  return {
    ...automation,
    steps: automation.steps.map((step) => {
      if (step.kind !== 'script') {
        return step
      }
      const { approvedPin: _pin, ...unapproved } = step
      return unapproved
    })
  }
}
