import type { Automation } from './automations-types'
import {
  EXTRA_AGENT_ARGS_REQUIRE_FRESH_SESSION,
  hasExtraAgentArgs,
  parseExtraAgentArgs
} from './automation-extra-agent-args'
import { resolveAutomationAgentStep } from './automation-steps'

/** Stored form of an extras input: the text unchanged, or `undefined` when it holds no extras. */
export function storedExtraAgentArgs(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string') {
    throw new Error('Extra agent arguments must be text.')
  }
  return hasExtraAgentArgs(value) ? value : undefined
}

/** Validates a whole record, so a patch that only enables Reuse still sees stored extras. */
export function assertAutomationExtraAgentArgs(
  automation: Pick<Automation, 'steps' | 'agentId' | 'prompt' | 'extraAgentArgs' | 'reuseSession'>
): void {
  if (!hasExtraAgentArgs(automation.extraAgentArgs)) {
    return
  }
  const agentStep = resolveAutomationAgentStep(automation)
  if (!agentStep) {
    // Why refuse rather than drop: extras are per-agent flags, so a plan with no
    // agent step has nothing to apply them to and silently keeping them would
    // make the record say something it does not do.
    throw new Error('Extra agent arguments need an agent step.')
  }
  if (automation.reuseSession) {
    throw new Error(EXTRA_AGENT_ARGS_REQUIRE_FRESH_SESSION)
  }
  const parsed = parseExtraAgentArgs({
    agent: agentStep.agentId,
    extraAgentArgs: automation.extraAgentArgs
  })
  if (!parsed.ok) {
    throw new Error(parsed.error)
  }
}
