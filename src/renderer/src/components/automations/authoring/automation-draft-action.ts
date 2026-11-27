import {
  DEFAULT_AUTOMATION_COMMAND_TIMEOUT_SECONDS,
  MAX_AUTOMATION_COMMAND_LENGTH,
  MAX_AUTOMATION_COMMAND_TIMEOUT_SECONDS,
  isCommandAutomation,
  normalizeAutomationScript
} from '../../../../../shared/automations/launch/automation-command'
import type {
  Automation,
  AutomationAction,
  AutomationScript,
  AutomationUpdateInput
} from '../../../../../shared/automations/automation-definition'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import { translate } from '@/i18n/i18n'
import type { AutomationDraft } from './AutomationEditorDialog'
import { buildDraftPrecheck } from './automation-draft-model'

export type AutomationScriptDraft = Omit<AutomationScript, 'timeoutSeconds'> & {
  timeoutSeconds: string
}

export const EMPTY_AUTOMATION_SCRIPT_DRAFT: AutomationScriptDraft = {
  command: '',
  timeoutSeconds: String(DEFAULT_AUTOMATION_COMMAND_TIMEOUT_SECONDS),
  shell: 'login',
  report: 'on-output'
}

export function isCommandDraft(draft: Pick<AutomationDraft, 'actionKind'>): boolean {
  return draft.actionKind === 'command'
}

export function buildScriptDraftFields(
  automation: Pick<Automation, 'action'>
): Pick<AutomationDraft, 'actionKind' | 'script'> {
  if (automation.action?.kind !== 'command') {
    return {}
  }
  const { script } = automation.action
  return {
    actionKind: 'command',
    script: { ...script, timeoutSeconds: String(script.timeoutSeconds) }
  }
}

export function selectDraftActionKind(
  current: AutomationDraft,
  kind: AutomationAction['kind'],
  agentId?: TuiAgent
): AutomationDraft {
  if (kind === 'agent') {
    return { ...current, actionKind: kind, ...(agentId ? { agentId } : {}) }
  }
  // A command has no session, so it neither reuses one nor creates a workspace per run.
  return {
    ...current,
    actionKind: kind,
    script: current.script ?? EMPTY_AUTOMATION_SCRIPT_DRAFT,
    workspaceMode: 'existing',
    reuseSession: false,
    setupDecision: undefined
  }
}

/** Why the draft's script cannot be saved yet, or null when it can. */
export function getDraftScriptError(draft: Pick<AutomationDraft, 'script'>): string | null {
  const command = draft.script?.command.trim() ?? ''
  if (!command) {
    return translate('automations.command.commandMissing', 'Enter a command before saving.')
  }
  if (command.length > MAX_AUTOMATION_COMMAND_LENGTH) {
    return translate(
      'automations.command.commandTooLong',
      'Keep the command to {{max}} characters or fewer.',
      { max: MAX_AUTOMATION_COMMAND_LENGTH }
    )
  }
  const timeout = Number(draft.script?.timeoutSeconds)
  if (
    !Number.isInteger(timeout) ||
    timeout < 1 ||
    timeout > MAX_AUTOMATION_COMMAND_TIMEOUT_SECONDS
  ) {
    return translate(
      'automations.command.timeoutInvalid',
      'Enter a timeout from 1 to {{max}} seconds.',
      { max: MAX_AUTOMATION_COMMAND_TIMEOUT_SECONDS }
    )
  }
  return null
}

/** The fields that make a saved automation run the draft's command instead of an agent. */
export function buildDraftCommandFields(draft: Pick<AutomationDraft, 'script'>): {
  action: AutomationAction
  agentId: null
  precheck: null
} {
  const script = draft.script
    ? normalizeAutomationScript({
        ...draft.script,
        timeoutSeconds: Number(draft.script.timeoutSeconds)
      })
    : null
  if (!script) {
    throw new Error(
      translate('automations.command.commandMissing', 'Enter a command before saving.')
    )
  }
  return { action: { kind: 'command', script }, agentId: null, precheck: null }
}

/** What a project save writes about the thing the automation runs. */
export function buildDraftActionUpdates(
  draft: AutomationDraft,
  current: Automation | null,
  edited: (key: keyof AutomationDraft) => boolean
): Pick<AutomationUpdateInput, 'action' | 'agentId' | 'precheck' | 'prompt'> {
  if (isCommandDraft(draft)) {
    return { ...buildDraftCommandFields(draft), ...(current ? {} : { prompt: '' }) }
  }
  const becomesAgent = !current || isCommandAutomation(current)
  return {
    ...(becomesAgent ? { action: { kind: 'agent' } } : {}),
    ...(becomesAgent || edited('prompt') ? { prompt: draft.prompt } : {}),
    ...(becomesAgent || edited('precheckCommand') || edited('precheckTimeoutSeconds')
      ? { precheck: buildDraftPrecheck(draft) }
      : {}),
    ...(becomesAgent || edited('agentId') ? { agentId: draft.agentId } : {})
  }
}
