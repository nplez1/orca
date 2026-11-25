import type { Automation } from '../../../shared/automations/automation-definition'
import type { AutomationRun } from '../../../shared/automations/history/automation-run'
import {
  automationScriptContentHash,
  automationScriptStepPin
} from '../../automations/dispatch/script-step-pin'

export type AutomationScriptStepApproval = { automationId: string; runId: string; stepId: string }

/**
 * Pins the content a run refused, as the user just reviewed it. Only the desktop's own IPC calls
 * this; no runtime RPC method reaches it, so agents, bots and paired clients cannot approve a script.
 * The pin is derived here from the run's recorded content, never taken from the caller.
 */
export function approveAutomationScriptStep(
  operations: {
    state: {
      automations: Pick<Automation, 'id' | 'steps'>[]
      automationRuns: readonly Pick<AutomationRun, 'id' | 'automationId' | 'stepResults'>[]
    }
    flush: () => void
  },
  request: AutomationScriptStepApproval
): void {
  const automation = operations.state.automations.find((entry) => entry.id === request.automationId)
  const run = operations.state.automationRuns.find(
    (entry) => entry.id === request.runId && entry.automationId === request.automationId
  )
  const result = run?.stepResults?.find((entry) => entry.stepId === request.stepId)
  if (!automation || !result || result.outcome !== 'unapproved' || !result.reviewContent) {
    throw new Error('This script step has nothing waiting for approval.')
  }
  const step = automation.steps?.find(
    (entry) => entry.kind === 'script' && entry.id === request.stepId
  )
  if (
    step?.kind !== 'script' ||
    step.script !== result.script ||
    JSON.stringify(step.args ?? []) !== JSON.stringify(result.args ?? [])
  ) {
    throw new Error('The script step changed since that run. Run it again to review it.')
  }
  const bytes = Buffer.from(result.reviewContent, 'utf8')
  // Text that does not round-trip is not what the file holds, so it could never match a run.
  if (automationScriptContentHash(bytes) !== result.contentHash) {
    throw new Error('This script is not UTF-8 text, so Orca cannot show and approve it.')
  }
  const approvedPin = automationScriptStepPin(step, bytes)
  // Replaced, not patched in place: the list projection caches on array identity.
  operations.state.automations = operations.state.automations.map((entry) =>
    entry.id === automation.id
      ? {
          ...entry,
          steps: entry.steps?.map((candidate) =>
            candidate === step ? { ...step, approvedPin } : candidate
          )
        }
      : entry
  )
  operations.flush()
}
