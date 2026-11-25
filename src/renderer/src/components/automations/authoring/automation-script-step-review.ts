import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import { confirmScriptContent } from '@/runtime/repo-hooks/hook-script-confirmation'
import type { Automation } from '../../../../../shared/automations/automation-definition'
import type { AutomationStepRecord } from '../../../../../shared/automations/steps/automation-steps'
import type { AutomationStepResult } from '../../../../../shared/automations/steps/automation-step-results'
import { getAutomationRunRepoId } from '../../../../../shared/automations/history/automation-run-identity'

/** A refused step the run recorded enough of to review: its content and that content's hash. */
export function isReviewableAutomationStep(
  automation: Pick<Automation, 'steps'> | null,
  result: AutomationStepResult
): boolean {
  return Boolean(
    automation?.steps?.some(
      (step) =>
        step.kind === 'script' &&
        step.id === result.stepId &&
        step.script === result.script &&
        step.approvedContentHash !== result.contentHash
    ) &&
    result.outcome === 'unapproved' &&
    result.reviewContent !== undefined &&
    result.contentHash
  )
}

/**
 * Shows the content a run refused in the hook trust prompt; approving pins that exact content on
 * the step, so the next run of this file runs it and any later change asks again.
 */
export async function reviewAutomationScriptStep(
  automation: Pick<Automation, 'projectId' | 'runContext' | 'steps'>,
  result: AutomationStepResult,
  saveSteps: (steps: AutomationStepRecord[]) => Promise<boolean>
): Promise<void> {
  const contentHash = result.contentHash
  if (!automation.steps || !contentHash || result.reviewContent === undefined) {
    return
  }
  const approval = await confirmScriptContent(
    useAppStore.getState(),
    getAutomationRunRepoId(automation),
    'automationScript',
    result.reviewContent,
    automation.runContext?.hostId,
    undefined,
    undefined,
    undefined,
    'automation'
  )
  if (approval.decision !== 'run') {
    return
  }
  // Pin what the run saw, even under repo-wide trust: the host checks every run against it.
  const steps = automation.steps.map((step) =>
    step.kind === 'script' && step.id === result.stepId && step.script === result.script
      ? { ...step, approvedContentHash: contentHash }
      : step
  )
  if (await saveSteps(steps)) {
    toast.success(
      translate(
        'automations.scriptSteps.approved',
        'Script approved. Later runs of this automation will run it.'
      )
    )
  }
}
