import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'
import { confirmAutomationScriptStep } from '@/runtime/repo-hooks/automation-script-step-confirmation'
import { findHookRepo } from '@/runtime/repo-hooks/hook-owner-resolution'
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

type ScriptStepReviewDeps = {
  state: Pick<AppState, 'openModal' | 'projectGroups' | 'repos'>
  approve: (request: { automationId: string; runId: string; stepId: string }) => Promise<void>
}

/**
 * Shows the step's path, exact arguments and the content a run refused, every time. On approval the
 * desktop host pins that run's recorded content itself (`approveScriptStep` IPC); nothing here
 * names a hash, and no runtime RPC caller (agent, bot, paired client) can reach that approval.
 */
export async function reviewAutomationScriptStep(
  automation: Pick<Automation, 'id' | 'projectId' | 'runContext'>,
  runId: string,
  result: AutomationStepResult,
  deps: ScriptStepReviewDeps = {
    state: useAppStore.getState(),
    approve: (request) => window.api.automations.approveScriptStep(request)
  }
): Promise<boolean> {
  if (result.reviewContent === undefined) {
    return false
  }
  const repoId = getAutomationRunRepoId(automation)
  const approved = await confirmAutomationScriptStep(deps.state, {
    repoId,
    repoName:
      findHookRepo(deps.state, repoId, automation.runContext?.hostId)?.displayName ??
      'this repository',
    script: result.script,
    args: result.args ?? [],
    content: result.reviewContent
  })
  if (!approved) {
    return false
  }
  await deps.approve({ automationId: automation.id, runId, stepId: result.stepId })
  toast.success(
    translate(
      'automations.scriptSteps.approved',
      'Script approved. Later runs of this automation will run it.'
    )
  )
  return true
}
