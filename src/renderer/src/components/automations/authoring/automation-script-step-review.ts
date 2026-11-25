import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import { confirmScriptContent } from '@/runtime/repo-hooks/hook-script-confirmation'
import type { Automation } from '../../../../../shared/automations/automation-definition'
import type { AutomationStepResult } from '../../../../../shared/automations/steps/automation-step-results'
import { getAutomationRunRepoId } from '../../../../../shared/automations/history/automation-run-identity'

function sameArgs(left: readonly string[] | undefined, right: readonly string[] | undefined) {
  return JSON.stringify(left ?? []) === JSON.stringify(right ?? [])
}

/** A refused step whose recorded content still belongs to the automation's current step. */
export function isReviewableAutomationStep(
  automation: Pick<Automation, 'steps'> | null,
  result: AutomationStepResult
): boolean {
  return Boolean(
    result.outcome === 'unapproved' &&
    result.reviewContent !== undefined &&
    automation?.steps?.some(
      (step) =>
        step.kind === 'script' &&
        step.id === result.stepId &&
        step.script === result.script &&
        sameArgs(step.args, result.args)
    )
  )
}

/**
 * Shows the content a run refused in the hook trust prompt. On approval the desktop host pins
 * that run's recorded content itself (`approveScriptStep` IPC); nothing here names a hash, and
 * no runtime RPC caller (agent, bot, paired client) can reach that approval.
 */
export async function reviewAutomationScriptStep(
  automation: Pick<Automation, 'id' | 'projectId' | 'runContext'>,
  runId: string,
  result: AutomationStepResult
): Promise<void> {
  if (result.reviewContent === undefined) {
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
  await window.api.automations.approveScriptStep({
    automationId: automation.id,
    runId,
    stepId: result.stepId
  })
  toast.success(
    translate(
      'automations.scriptSteps.approved',
      'Script approved. Later runs of this automation will run it.'
    )
  )
}
