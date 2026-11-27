import { useAppStore } from '@/store/index'
import {
  automationChatSupport,
  automationDraftSurface,
  automationLaunchWorkspace
} from './automation-launch-surface'
import { toast } from 'sonner'
import { isTuiAgentEnabled } from '../../../../../shared/agent-launch/catalog/tui-agent-selection'
import { isValidAutomationSchedule } from '../../../../../shared/automations/scheduling/automation-schedule-parsing'
import { translate } from '@/i18n/i18n'
import { acceptsAutomationDraftSchedule } from '../../../../../shared/automations/scheduling/automation-schedule-input-gate'
import {
  draftExtraAgentArgsNeedFreshSession,
  getDraftExtraAgentArgsError,
  parseDraftTime
} from './automation-draft-model'
import { saveOrcaAutomation } from './automation-orca-save'
import { botTargetError, saveBotAutomation } from './automation-bot-save'
import { getDraftScriptError, isCommandDraft } from './automation-draft-action'
import type { AutomationSaveContext } from './automation-save-context'

/** Validates editor input then runs the Orca save transaction. */
export function createAutomationSaveAction(context: AutomationSaveContext) {
  return async function saveAutomation(now = Date.now()): Promise<void> {
    const { store, local, destinationForm, destination } = context
    const { settings } = store
    const { draft, editingAutomationId, setIsSaving, setEditorNotice, setEditorNoticeHost } = local
    const { draftAtOpen } = local
    const targetEdited = editingAutomationId === null || local.targetEdited
    const scheduleEdited =
      editingAutomationId === null ||
      !draftAtOpen ||
      (['preset', 'time', 'dayOfWeek', 'customSchedule'] as const).some(
        (key) => draft[key] !== draftAtOpen[key]
      )
    const extrasEdited =
      editingAutomationId === null ||
      !draftAtOpen ||
      draft.launchSetupPatch !== undefined ||
      draft.surface !== draftAtOpen.surface ||
      draft.extraAgentArgs !== draftAtOpen.extraAgentArgs ||
      draft.agentId !== draftAtOpen.agentId ||
      draft.reuseSession !== draftAtOpen.reuseSession ||
      draft.workspaceMode !== draftAtOpen.workspaceMode
    const { hour, minute } = parseDraftTime(draft.time)
    const botTarget = draft.bot
    const runsScript = isCommandDraft(draft)
    const scriptError = runsScript ? getDraftScriptError(draft) : null
    if (scriptError) {
      toast.error(scriptError)
      return
    }
    if (botTarget && !runsScript && !draft.prompt.trim()) {
      toast.error(translate('automations.botTarget.promptMissing', 'Enter what it should do.'))
      return
    }
    if (
      !botTarget &&
      ((targetEdited &&
        (!draft.projectId || (draft.workspaceMode === 'existing' && !draft.workspaceId))) ||
        (!runsScript && !draft.prompt.trim()))
    ) {
      toast.error(
        runsScript
          ? translate('automations.command.locationMissing', 'Choose a run location before saving.')
          : translate(
              'auto.components.automations.AutomationsPage.2430fecf53',
              'Choose a run location and enter a prompt before saving.'
            )
      )
      return
    }
    // Only on events: the schedule fields are hidden and not saved.
    if (scheduleEdited && draft.scheduleWarning && !draft.eventsOnly) {
      toast.error(
        translate(
          'auto.components.automations.AutomationsPage.64bdb2304f',
          'Pick a supported schedule before saving.'
        )
      )
      return
    }
    if (
      !draft.eventsOnly &&
      scheduleEdited &&
      draft.preset === 'custom' &&
      !acceptsAutomationDraftSchedule({
        customSchedule: draft.customSchedule,
        savedRrule: draft.savedSchedule,
        validate: isValidAutomationSchedule
      })
    ) {
      toast.error(
        translate(
          'auto.components.automations.AutomationsPage.6e91dab317',
          'Enter a valid advanced schedule before saving.'
        )
      )
      return
    }
    if (botTarget) {
      const targetError = botTargetError(botTarget)
      if (targetError) {
        toast.error(targetError)
        return
      }
      setEditorNotice(null)
      setEditorNoticeHost(null)
      setIsSaving(true)
      try {
        await saveBotAutomation(context, botTarget, { hour, minute, now })
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.automations.AutomationsPage.b11170a008',
                'Failed to save automation.'
              )
        )
      } finally {
        setIsSaving(false)
      }
      return
    }
    if (
      !runsScript &&
      (editingAutomationId === null || draftAtOpen?.actionKind === 'command') &&
      !isTuiAgentEnabled(draft.agentId, settings?.disabledTuiAgents)
    ) {
      toast.error(
        translate(
          'auto.components.automations.AutomationsPage.2360ffc956',
          'Choose an enabled agent before saving.'
        )
      )
      return
    }
    const resolution =
      editingAutomationId !== null
        ? destinationForm.editHostResolution
        : destination.createDestination.control.resolution
    const chatSupported = automationChatSupport(
      useAppStore.getState(),
      draft,
      automationLaunchWorkspace(draft, resolution)
    )
    const surface = runsScript ? 'terminal' : automationDraftSurface(draft, settings, chatSupported)
    if (surface === 'chat' && chatSupported !== true) {
      return
    }
    const effectiveDraft = { ...draft, surface }
    const extrasError = draftExtraAgentArgsNeedFreshSession(effectiveDraft)
      ? draft.launchPreferences !== undefined || draft.agentArgs !== undefined
        ? translate(
            'auto.components.automations.launchSettings.needsFreshSession',
            'Agent launch settings require a fresh session for every run.'
          )
        : translate(
            'auto.components.automations.extraAgentArgs.needsFreshSession',
            'Extra arguments require a fresh session for every run.'
          )
      : getDraftExtraAgentArgsError(effectiveDraft)
    if (!runsScript && extrasEdited && extrasError) {
      toast.error(extrasError)
      return
    }
    setEditorNotice(null)
    setEditorNoticeHost(null)
    setIsSaving(true)
    try {
      if (editingAutomationId === null) {
        const checked = destination.createDestination.check(draft.projectId)
        if (!checked.ok) {
          setEditorNotice(checked.notice)
          return
        }
      }
      const selectedWorkspaceExists =
        destinationForm.recordedTargetSelected ||
        draft.workspaceMode !== 'existing' ||
        destinationForm.dialogWorktrees.some((worktree) => worktree.id === draft.workspaceId)
      if (targetEdited && !selectedWorkspaceExists) {
        toast.error(
          translate(
            'auto.components.automations.AutomationsPage.32534e7c9c',
            'Choose an available workspace before saving.'
          )
        )
        return
      }
      await saveOrcaAutomation(context, { hour, minute, now, surface })
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : translate(
              'auto.components.automations.AutomationsPage.b11170a008',
              'Failed to save automation.'
            )
      )
    } finally {
      setIsSaving(false)
    }
  }
}

export type AutomationSaveAction = ReturnType<typeof createAutomationSaveAction>
