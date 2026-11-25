import type { Automation } from '../../../shared/automations/automation-definition'
import {
  AUTOMATION_SCRIPT_ONLY_FALLBACK_PROMPT,
  AutomationStepsError,
  automationRunsAgentStep,
  parseAutomationStepsForWrite
} from '../../../shared/automations/steps/automation-steps'

/**
 * Settles `steps` on a record being written. A write that names steps replaces them (null
 * clears); any other write keeps the stored ones.
 */
export function applyAutomationStepsWrite(
  automation: Pick<Automation, 'steps' | 'prompt'> & { bot?: unknown },
  write: { steps?: unknown },
  current?: Pick<Automation, 'steps'>
): void {
  const steps = Object.hasOwn(write, 'steps')
    ? parseAutomationStepsForWrite(write.steps)
    : current?.steps
  delete automation.steps
  if (!steps) {
    return
  }
  if (automation.bot) {
    throw new AutomationStepsError('steps_invalid', 'A bot automation cannot have script steps.')
  }
  automation.steps = steps
  if (!automationRunsAgentStep(automation)) {
    // An older host ignores steps and launches this prompt; it tells the agent to stand down.
    automation.prompt = AUTOMATION_SCRIPT_ONLY_FALLBACK_PROMPT
  }
}
