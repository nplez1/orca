import type { Automation } from '../../../../../shared/automations/automation-definition'
import {
  AUTOMATION_AGENT_STEP_ID,
  DEFAULT_AUTOMATION_SCRIPT_STEP_TIMEOUT_SECONDS,
  automationRunsAgentStep,
  getAutomationScriptSteps,
  validateAutomationSteps,
  type AutomationScriptStepFailurePolicy,
  type AutomationStepRecord
} from '../../../../../shared/automations/steps/automation-steps'

export type AutomationScriptStepDraft = {
  /** Stable row identity while the id is being typed or the rows are reordered; never saved. */
  key: string
  id: string
  script: string
  /** Space-separated; the editor does not take arguments that contain spaces. */
  args: string
  timeoutSeconds: string
  onFailure: AutomationScriptStepFailurePolicy
  /** Kept only while `script` still names the file it was approved for. */
  approved?: { script: string; contentHash: string }
}

export function scriptStepDraftsFromAutomation(
  automation: Pick<Automation, 'steps'>
): AutomationScriptStepDraft[] {
  return getAutomationScriptSteps(automation).map((step) => ({
    key: step.id,
    id: step.id,
    script: step.script,
    args: (step.args ?? []).join(' '),
    timeoutSeconds: String(step.timeoutSeconds),
    onFailure: step.onFailure,
    ...(step.approvedContentHash
      ? { approved: { script: step.script, contentHash: step.approvedContentHash } }
      : {})
  }))
}

export function runsAgentStepFromAutomation(automation: Pick<Automation, 'steps'>): boolean {
  return automationRunsAgentStep(automation)
}

/** The next unused default id: script, script2, script3... */
export function nextScriptStepId(steps: readonly AutomationScriptStepDraft[]): string {
  const used = new Set(steps.map((step) => step.id))
  for (let index = 1; ; index += 1) {
    const id = index === 1 ? 'script' : `script${index}`
    if (!used.has(id)) {
      return id
    }
  }
}

// A counter, not randomUUID: crypto is absent on the LAN web client's insecure origin.
let newStepKeys = 0

export function newScriptStepDraft(
  steps: readonly AutomationScriptStepDraft[]
): AutomationScriptStepDraft {
  return {
    key: `new-${(newStepKeys += 1)}`,
    id: nextScriptStepId(steps),
    script: '',
    args: '',
    timeoutSeconds: String(DEFAULT_AUTOMATION_SCRIPT_STEP_TIMEOUT_SECONDS),
    onFailure: 'stop'
  }
}

export function moveScriptStepDraft(
  steps: readonly AutomationScriptStepDraft[],
  index: number,
  offset: -1 | 1
): AutomationScriptStepDraft[] {
  const target = index + offset
  if (target < 0 || target >= steps.length) {
    return [...steps]
  }
  const next = [...steps]
  ;[next[index], next[target]] = [next[target]!, next[index]!]
  return next
}

/** The persisted steps, or null for the one-step agent case (which saves as no steps). */
export function buildDraftSteps(draft: {
  scriptSteps?: readonly AutomationScriptStepDraft[]
  runAgentStep?: boolean
}): AutomationStepRecord[] | null {
  const scripts = draft.scriptSteps ?? []
  if (scripts.length === 0) {
    return null
  }
  const steps: AutomationStepRecord[] = scripts.map((step) => {
    const script = step.script.trim()
    const args = step.args.trim() ? step.args.trim().split(/\s+/) : []
    const timeout = Number(step.timeoutSeconds)
    return {
      kind: 'script',
      id: step.id.trim(),
      script,
      ...(args.length > 0 ? { args } : {}),
      timeoutSeconds: Number.isFinite(timeout)
        ? timeout
        : DEFAULT_AUTOMATION_SCRIPT_STEP_TIMEOUT_SECONDS,
      onFailure: step.onFailure,
      ...(step.approved && step.approved.script === script
        ? { approvedContentHash: step.approved.contentHash }
        : {})
    }
  })
  return draft.runAgentStep === false
    ? steps
    : [...steps, { kind: 'agent', id: AUTOMATION_AGENT_STEP_ID }]
}

/** The first problem with the draft's steps, phrased by the same validator the host runs. */
export function getDraftScriptStepsError(draft: {
  scriptSteps?: readonly AutomationScriptStepDraft[]
  runAgentStep?: boolean
}): string | null {
  const steps = buildDraftSteps(draft)
  if (!steps) {
    return null
  }
  const parsed = validateAutomationSteps(steps)
  return parsed.ok ? null : parsed.error
}
