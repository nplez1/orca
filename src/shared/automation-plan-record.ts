/**
 * The two rules about a plan that belong to the record rather than to its steps.
 *
 * Both are asserted by the store, the only writer of an automation, and both need
 * the whole record in hand: the flat `prompt`/`agentId` pair has to agree with the
 * plan's agent step, and the flat `precheck` gate has to agree with there being a
 * plan at all.
 *
 * `precheck` is the flat model's gate: one command that decides whether the run
 * happens. A plan says the same thing as its first script step with
 * `onFailure: "stop"`, which is also where that step's timeout and output live.
 * Accepting both would mean two gates with no defined order, so the pair is refused
 * with the migration in the message.
 */

import type { Automation, AutomationPrecheck } from './automations-types'
import {
  applyAutomationStepPatch,
  automationLegacyAgentFields,
  type AutomationStep,
  type AutomationStepPatch,
  type AutomationStepSource
} from './automation-steps'
import { normalizeAutomationPrecheck } from './automation-precheck'

/**
 * Keeps the flat agent fields describing the plan's agent step.
 *
 * They stay on the record for readers that predate steps, and are cleared rather
 * than left stale when the plan has no agent step, so an older reader is told
 * "this automation has no prompt" instead of being handed one that never runs.
 */
export function applyAutomationPlanRecordMirror(record: Automation): void {
  const mirror = automationLegacyAgentFields(record)
  record.prompt = mirror.prompt
  if (mirror.agentId === null) {
    delete record.agentId
  } else {
    record.agentId = mirror.agentId
  }
}

export function describeAutomationPlanPrecheckConflict(input: {
  hasSteps: boolean
  precheck: AutomationPrecheck | null | undefined
}): string | null {
  if (!input.hasSteps || !input.precheck) {
    return null
  }
  return 'A precheck and steps cannot both be set: express the gate as the first script step with onFailure "stop", or clear the precheck.'
}

export type AutomationPlanWrite = {
  /** Null means "leave the stored plan alone"; a create never gets null back. */
  steps: AutomationStep[] | null
  precheck: AutomationPrecheck | null
}

/**
 * The plan fields a write stores, with both rules applied.
 *
 * One implementation for the two writers because the rules are identical in both:
 * the patch decides the plan (a create must end up with one, an update may leave an
 * existing plan untouched), and the plan decides whether a flat precheck may stay.
 * Throws the sentences the RPC and CLI surfaces show verbatim.
 */
export function resolveAutomationPlanWrite(input: {
  current: AutomationStepSource
  currentPrecheck: AutomationPrecheck | null | undefined
  patch: AutomationStepPatch
  /** The patch's precheck when it carried one; `undefined` preserves the stored gate. */
  patchedPrecheck: AutomationPrecheck | null | undefined
  hasPrecheckPatch: boolean
  /** Whether the record already has a plan of its own, for the precheck rule. */
  currentHasPlan: boolean
  /** Whether the write carries `steps` itself, rather than one flat agent step. */
  hasStepsPatch: boolean
  requirePlan: boolean
}): AutomationPlanWrite {
  const plan = applyAutomationStepPatch({ current: input.current, patch: input.patch })
  if (!plan.ok) {
    throw new Error(plan.error)
  }
  if (plan.steps === null && input.requirePlan) {
    throw new Error('An automation needs at least one step.')
  }
  const precheck = normalizeAutomationPrecheck(
    input.hasPrecheckPatch ? input.patchedPrecheck : input.currentPrecheck
  )
  // Only an *explicit* plan disqualifies a precheck: the flat prompt/agentId pair is
  // also one agent step, and a precheck over it is the model that has always existed.
  const conflict = describeAutomationPlanPrecheckConflict({
    hasSteps: input.hasStepsPatch || input.currentHasPlan,
    precheck
  })
  if (conflict) {
    throw new Error(conflict)
  }
  return { steps: plan.steps, precheck }
}
